import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = (await readFile("public/app/api.js", "utf8")).replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function client(fetch: (...args: any[]) => any, duringWait?: () => void) {
  const waits: number[] = [];
  const logs: unknown[][] = [];
  const alerts: Array<{ kind: string; message: string }> = [];
  const window = new EventTarget();
  window.addEventListener("joint-bob-client-error", (event) => alerts.push((event as CustomEvent).detail));
  let signedOut = false;
  const requests = runInNewContext(`${source}\n({ api, apiBlob, apiLines, savePreferencesInBackground })`, {
    fetch, Error, TypeError, window, CustomEvent, Event, clearTimeout,
    setTimeout: (done: () => void, ms: number) => {
      waits.push(ms);
      if (!duringWait) return setTimeout(done, 0);
      queueMicrotask(duringWait);
    }, console: { warn: (...args: unknown[]) => logs.push(args) },
    state: { csrfToken: "synthetic-csrf" }, showSignedOut: () => { signedOut = true; }, recordFailure: () => {}, TextDecoderStream,
  });
  return { ...requests, logs, alerts, waits, signedOut: () => signedOut };
}

test("an unexplained fetch abort names the request and is not treated as user cancellation", async () => {
  const error = new DOMException("This operation was aborted", "AbortError");
  const request = client(async () => { throw error; });
  await assert.rejects(request.api("/api/projects?search=private-query#private-fragment"), (failure: any) => {
    assert.match(failure.message, /GET \/api\/projects/);
    assert.match(failure.message, /interrupted/i);
    assert.doesNotMatch(failure.message, /timed out|private-query|private-fragment/);
    assert.equal(failure.cancelled, false);
    assert.equal(failure.name, "AbortError", "existing GET-only timeout retry logic needs the original name");
    assert.equal(failure.status, 0);
    assert.equal(failure.path, "/api/projects");
    assert.equal(failure.cause, error);
    return true;
  });
  assert.equal(request.logs.length, 1, "caught failures must still reach Settings logs");
  assert.match(JSON.stringify(request.logs), /GET.*\/api\/projects/);
  assert.match(request.alerts[0]?.message ?? "", /GET \/api\/projects/);
  assert.equal(request.alerts.length, 1);
  assert.doesNotMatch(JSON.stringify([request.logs, request.alerts]), /private-query|private-fragment|synthetic-csrf/);
});

test("a server-side abort identifies the write and warns that its outcome is unknown", async () => {
  let calls = 0;
  const request = client(async () => {
    calls++;
    return Response.json({ error: "This operation was aborted" }, { status: 500 });
  });
  await assert.rejects(request.api("/api/preferences?token=private-token", {
    method: "put", body: JSON.stringify({ password: "private-body" }), headers: { Authorization: "private-header" },
  }), (failure: any) => {
    assert.match(failure.message, /PUT \/api\/preferences/);
    assert.match(failure.message, /interrupted/i);
    assert.match(failure.message, /check.*before.*try/i);
    assert.equal(failure.status, 500);
    assert.equal(failure.cancelled, false);
    return true;
  });
  assert.equal(calls, 1, "never replay an uncertain write");
  assert.doesNotMatch(JSON.stringify(request.logs), /private-token|private-body|private-header|synthetic-csrf/);
});

test("only a confirmed caller cancellation is quiet", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = client(async () => { throw controller.signal.reason; });
  await assert.rejects(request.api("/api/projects", { signal: controller.signal }), (failure: any) => {
    assert.equal(failure.cancelled, true);
    assert.equal(failure.name, "AbortError");
    return true;
  });
  assert.equal(request.logs.length, 0);
  assert.deepEqual(request.alerts, []);
});

test("an aborted signal does not hide an unrelated failure", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = client(async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(request.api("/api/projects", { signal: controller.signal }), (failure: any) => {
    assert.equal(failure.cancelled, false);
    assert.match(failure.message, /GET \/api\/projects/);
    return true;
  });
  assert.equal(request.logs.length, 1);
});

test("a caller timeout stays visible and retains its error name", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("The operation timed out", "TimeoutError"));
  const request = client(async () => { throw controller.signal.reason; });
  await assert.rejects(request.api("/api/usage", { signal: controller.signal }), (failure: any) => {
    assert.equal(failure.cancelled, false);
    assert.equal(failure.name, "TimeoutError");
    assert.match(failure.message, /GET \/api\/usage.*timed out/);
    return true;
  });
  assert.equal(request.logs.length, 1);
});

for (const kind of ["api", "apiBlob", "apiLines"]) {
  test(`${kind} preserves request context when the response body is interrupted`, async () => {
    const error = new DOMException("This operation was aborted", "AbortError");
    const request = client(async () => new Response(new ReadableStream({ start(stream) { stream.error(error); } }), {
      headers: { "Content-Type": kind === "apiLines" ? "application/x-ndjson" : "application/json" },
    }));
    await assert.rejects(request[kind]("/api/story", {}, () => {}), (failure: any) => {
      assert.match(failure.message, /GET \/api\/story.*interrupted/);
      assert.equal(failure.status, 200);
      assert.equal(failure.cancelled, false);
      return true;
    });
    assert.equal(request.logs.length, 1);
  });
}

test("a read that gets no answer is retried without telling anyone", async () => {
  let calls = 0;
  const request = client(async () => {
    if (++calls < 3) throw new TypeError("Load failed");
    return Response.json({ ok: true });
  });
  assert.deepEqual(await request.api("/api/projects"), { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(request.waits, [1_000, 3_000]);
  assert.deepEqual([...request.logs, ...request.alerts], []);
});

test("a read that never gets an answer is reported once, after the retries", async () => {
  let calls = 0;
  const request = client(async () => { calls++; throw new TypeError("Load failed"); });
  await assert.rejects(request.api("/api/projects"), /GET \/api\/projects: No response was received/);
  assert.equal(calls, 4);
  assert.equal(request.alerts.length, 1);
});

test("a proxy that cannot reach the app is treated like no answer for reads", async () => {
  let calls = 0;
  const restarting = client(async () => {
    if (++calls < 3) return new Response("The machine did not answer through the relay.", { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return Response.json({ ok: true });
  });
  assert.deepEqual(await restarting.api("/api/harnesses"), { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual([...restarting.logs, ...restarting.alerts], []);

  const down = client(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  await assert.rejects(down.api("/api/team-hub"), (failure: any) => {
    assert.match(failure.message, /GET \/api\/team-hub: No response was received/);
    assert.equal(failure.status, 0);
    return true;
  });
  assert.equal(down.waits.length, 3);

  let writes = 0;
  const write = client(async () => { writes++; return new Response("Bad Gateway", { status: 502 }); });
  await assert.rejects(write.api("/api/preferences", { method: "PUT" }), /HTTP 502|Bad Gateway/);
  assert.equal(writes, 1);

  let appCalls = 0;
  const app = client(async () => { appCalls++; return Response.json({ error: "The machine that hosts the team refused it (500)" }, { status: 502 }); });
  await assert.rejects(app.api("/api/team-hub"), /hosts the team refused it/);
  assert.equal(appCalls, 1);
});

test("a starting app's 503 with Retry-After is treated like no answer for reads", async () => {
  const starting = () => Response.json({ error: "This node is starting" }, { status: 503, headers: { "Retry-After": "5" } });
  let calls = 0;
  const restarting = client(async () => (++calls < 3 ? starting() : Response.json({ ok: true })));
  assert.deepEqual(await restarting.api("/api/cluster/inventory"), { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual([...restarting.logs, ...restarting.alerts], []);

  const stillStarting = client(async () => starting());
  await assert.rejects(stillStarting.api("/api/cluster/node"), /GET \/api\/cluster\/node: No response was received/);
  assert.equal(stillStarting.waits.length, 3);

  let writes = 0;
  const write = client(async () => { writes++; return starting(); });
  await assert.rejects(write.api("/api/cluster/node", { method: "PUT" }), /This node is starting/);
  assert.equal(writes, 1);

  let unavailableCalls = 0;
  const unavailable = client(async () => { unavailableCalls++; return Response.json({ error: "Browser node is no longer paired" }, { status: 503 }); });
  await assert.rejects(unavailable.api("/api/browser/status"), /Browser node is no longer paired/);
  assert.equal(unavailableCalls, 1, "the app's other 503 answers are explanations, not a restart");
});

test("a write that gets no answer is never sent again", async () => {
  let calls = 0;
  const request = client(async () => { calls++; throw new TypeError("Load failed"); });
  await assert.rejects(request.api("/api/preferences", { method: "PUT" }), /No response was received/);
  assert.equal(calls, 1);
});

test("a dropped background write logs locally without raising a notice, while HTTP errors still alert", async () => {
  const dropped = client(async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(dropped.api("/api/preferences", { method: "PUT", background: true }), /No response was received/);
  assert.equal(dropped.logs.length, 1);
  assert.deepEqual(dropped.alerts, []);

  dropped.savePreferencesInBackground({ activeProjectId: "p1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dropped.alerts.length, 0);

  const aborted = client(async () => { throw new DOMException("This operation was aborted", "AbortError"); });
  await assert.rejects(aborted.api("/api/recents", { method: "PUT", background: true }), /interrupted/i);
  assert.equal(aborted.logs.length, 1);
  assert.deepEqual(aborted.alerts, []);

  const serverError = client(async () => Response.json({ error: "Disk full" }, { status: 500 }));
  await assert.rejects(serverError.api("/api/preferences", { method: "PUT", background: true }), /Disk full/);
  assert.equal(serverError.alerts.length, 1);
});

test("cancelling while a retry is waiting stays quiet", async () => {
  const controller = new AbortController();
  const request = client(async (_path: string, init: RequestInit) => {
    if (init.signal!.aborted) throw init.signal!.reason;
    throw new TypeError("Load failed");
  }, () => controller.abort());
  await assert.rejects(request.api("/api/projects", { signal: controller.signal }), (failure: any) => failure.cancelled);
  assert.deepEqual(request.alerts, []);
});

test("HTTP errors retain server explanations and conflict details", async () => {
  const details = { code: "transcript-conflict", sources: ["fixture"] };
  const request = client(async () => Response.json({ error: "History differs between machines", details }, { status: 409 }));
  await assert.rejects(request.api("/api/projects/example/sessions/take-ownership", { method: "POST" }), (failure: any) => {
    assert.match(failure.message, /POST \/api\/projects\/example\/sessions\/take-ownership/);
    assert.match(failure.message, /History differs between machines/);
    assert.equal(failure.status, 409);
    assert.deepEqual(failure.details, details);
    return true;
  });
});

test("a gateway timeout has a useful explanation even with a non-JSON error body", async () => {
  const request = client(async () => new Response("<html>private gateway response</html>", { status: 504 }));
  await assert.rejects(request.api("/api/projects"), /GET \/api\/projects.*timed out/);
  assert.doesNotMatch(JSON.stringify(request.logs), /private gateway response/);
});

test("authentication handling and successful responses remain unchanged", async () => {
  const unauthorized = client(async () => Response.json({ error: "Sign in required" }, { status: 401 }));
  await assert.rejects(unauthorized.api("/api/projects"), /Sign in required/);
  assert.equal(unauthorized.signedOut(), true);
  const signIn = client(async () => Response.json({ error: "Invalid credentials" }, { status: 401 }));
  await assert.rejects(signIn.api("/api/auth/login", { method: "POST" }));
  assert.equal(signIn.signedOut(), false);
  const json = client(async () => Response.json({ ok: true }));
  assert.deepEqual(await json.api("/api/projects"), { ok: true });
  const empty = client(async () => new Response(null, { status: 204 }));
  assert.equal(await empty.api("/api/projects", { method: "DELETE" }), null);
  const binary = client(async () => new Response("audio"));
  assert.equal(await (await binary.apiBlob("/api/story")).text(), "audio");
  const lines = client(async () => new Response('{"type":"progress"}\n{"type":"done"}', { headers: { "Content-Type": "application/x-ndjson" } }));
  const received: unknown[] = [];
  await lines.apiLines("/api/story", {}, (line: unknown) => received.push(line));
  assert.equal(JSON.stringify(received), '[{"type":"progress"},{"type":"done"}]');
  assert.deepEqual([...json.logs, ...empty.logs, ...binary.logs, ...lines.logs], []);
});

test("disconnect notice ignores dropped background writes, clears reads on server answer, and updates wording on write reconnect", async () => {
  class StubElement extends EventTarget {
    className = "";
    dataset: Record<string, string> = {};
    textContent = "";
    children: StubElement[] = [];
    parentElement: StubElement | null = null;
    classList = {
      classes: new Set<string>(),
      add: (name: string) => this.classList.classes.add(name),
      contains: (name: string) => this.classList.classes.has(name),
      toggle: (name: string, force?: boolean) => (force ? this.classList.classes.add(name) : this.classList.classes.delete(name)),
    };
    get childElementCount() { return this.children.length; }
    get isConnected() { return this.parentElement !== null; }
    setAttribute() {}
    append(...nodes: StubElement[]) {
      for (const node of nodes) {
        if (node.parentElement) node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    querySelector(selector: string): StubElement | null {
      const want = selector.startsWith(".") ? selector.slice(1) : null;
      for (const child of this.children) {
        if (want && child.className.split(/\s+/).includes(want)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
  }

  const window = new EventTarget();
  const body = new StubElement();
  const document = Object.assign(new EventTarget(), {
    body,
    documentElement: new StubElement(),
    createElement: () => new StubElement(),
  });
  const elements = new Proxy({}, { get: () => new StubElement() });
  const apiSource = (await readFile("public/app/api.js", "utf8")).replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  const shellSource = (await readFile("public/app/shell.js", "utf8")).replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  let failNetwork = true;
  const apiMod = runInNewContext(`${apiSource}\n({ api, NO_RESPONSE, UNCERTAIN_WRITE, savePreferencesInBackground })`, {
    fetch: async () => {
      if (failNetwork) throw new TypeError("Failed to fetch");
      return Response.json({ ok: true });
    },
    Error, TypeError, window, CustomEvent, Event, clearTimeout,
    setTimeout: (done: () => void) => setTimeout(done, 0),
    console: { warn: () => {} },
    state: { csrfToken: "synthetic-csrf" }, showSignedOut: () => {}, recordFailure: () => {}, TextDecoderStream,
  });
  runInNewContext(`${shellSource}\n({ toast })`, {
    ...apiMod, window, document, elements, CustomEvent, Event,
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ animationName: "none" }),
    setTimeout: () => 0, clearTimeout: () => {},
    topmostOpenDialog: () => null,
    state: {}, sendSocket: () => {}, copyErrorReport: async () => {}, downloadErrorReport: () => {},
    reportClientError: async () => null, openSettings: async () => {},
  });

  const toasts = () => body.children[0]?.children.map((node) => node.querySelector(".toast-message")?.textContent) ?? [];

  await assert.rejects(apiMod.api("/api/preferences", { method: "PUT", background: true }), /No response was received/);
  assert.deepEqual(toasts(), [], "dropped background write must not open a disconnect notice");

  await assert.rejects(apiMod.api("/api/projects"), /No response was received/);
  assert.deepEqual(toasts(), ["No connection to Joint Bob. Check that any recent change was saved."]);

  window.dispatchEvent(new Event("joint-bob-server-answered"));
  assert.deepEqual(toasts(), [], "server answer clears read-only disconnect notice");

  await assert.rejects(apiMod.api("/api/preferences", { method: "PUT" }), /No response was received/);
  assert.deepEqual(toasts(), ["No connection to Joint Bob. Check that any recent change was saved."]);

  failNetwork = false;
  await apiMod.api("/api/preferences");
  assert.deepEqual(toasts(), ["Connection to Joint Bob was briefly lost. Check that your recent change was saved."]);

  const socketSource = await readFile("public/app/socket.js", "utf8");
  assert.equal((socketSource.match(/joint-bob-server-answered/g) ?? []).length, 4, "conversation and watch sockets both report server answers on open and message");
});
