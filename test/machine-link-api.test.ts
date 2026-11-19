import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { waitForAssertion } from "./async-assertion.js";

interface Summary { issuer: string; own: boolean; relays: Array<{ origin: string; pass: boolean }>; twins: string[]; clusters: string[] }
interface Step { kind: string; title: string; status: string; detail: string }
interface Machine { environment: DevEnvironment; node: SeededNode; session: SignedIn }

// Real node processes: a relay, two machines that are twins and reachable only through it, and a
// new machine that one pasted link turns into a twin of both and a member of their cluster.
test("one link puts a new machine on the relay, makes it a twin of every machine its owner has, and joins the chosen cluster", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "machine-link-api-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const environments = await Promise.all(["relay", "mac", "server", "new"].map((name) => seedDevEnvironment(path.join(root, name), 1)));
    for (const environment of environments) children.push(await startDevNode(environment, environment.nodes[0]));
    const [relay, mac, server, added]: Machine[] = await Promise.all(environments.map(async (environment) => ({ environment, node: environment.nodes[0], session: await signIn(environment, environment.nodes[0]) })));
    const call = <T>(machine: Machine, method: string, endpoint: string, body?: unknown) => api<T>(machine.node, machine.session, method, endpoint, body);
    // The route answers 204 with no body, which the shared api() helper cannot read.
    const serving = (memberInvites: boolean) => fetch(`${relay.node.url}/api/relay/serving`, { method: "PUT", headers: { Cookie: relay.session.cookie, "x-csrf-token": relay.session.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, origin: `http://localhost:${relay.node.port}`, environment: "test", requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: "", ownMachinesOnly: false, memberInvites }) });
    assert.equal((await serving(true)).status, 204);

    // The owner's two machines sit behind the relay with no address of their own, like a laptop and a home server.
    for (const [machine, name] of [[mac, "MacBook"], [server, "Homeserver"]] as const) {
      const token = await call<{ link: string }>(relay, "POST", "/relay/serving/tokens", { label: name });
      assert.equal((await call(machine, "POST", "/relays", { link: token.body.link })).status, 201);
      await waitForAssertion(async () => assert.equal((await call<{ relays: Array<{ status: string; connected: boolean }> }>(machine, "GET", "/relays")).body.relays[0]?.connected, true), 20_000);
      assert.equal((await call(machine, "PUT", "/cluster/node", { name, url: "" })).status, 200);
    }
    assert.equal((await call(added, "PUT", "/cluster/node", { name: "HomeMac", url: "" })).status, 200);
    const twinLink = await call<{ link: string }>(mac, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(twinLink.status, 201);
    await waitForAssertion(async () => assert.equal((await call(server, "POST", "/twins/accept", { link: twinLink.body.link, confirmOwnedData: true })).status, 201), 30_000);
    const cluster = await call<{ snapshot: { body: { clusterId: string } } }>(mac, "POST", "/clusters", { name: "Home cluster" });
    assert.equal(cluster.status, 201);
    const clusterId = cluster.body.snapshot.body.clusterId;

    // Sharing everything needs the same explicit confirmation as a twin link.
    assert.equal((await call(mac, "POST", "/machine-links", { own: true, clusterIds: [clusterId] })).status, 400);
    const created = await call<{ link: string; summary: Summary; notes: string[] }>(mac, "POST", "/machine-links", { own: true, clusterIds: [clusterId], confirmOwnedData: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.notes, []);
    assert.deepEqual(created.body.summary.twins, ["MacBook", "Homeserver"], "the issuer's twin adds its own invitation");
    assert.deepEqual(created.body.summary.clusters, ["Home cluster"]);
    assert.deepEqual(created.body.summary.relays.map((item) => item.pass), [true], "the relay hands the issuer a pass for the new machine");

    // The machine that made the link is told so rather than twinned with itself.
    const own = await call<{ issuedHere: boolean }>(mac, "POST", "/machine-links/inspect", { link: created.body.link });
    assert.equal(own.body.issuedHere, true);
    assert.equal((await call(mac, "POST", "/machine-links/use", { link: created.body.link, confirmOwnedData: true })).status, 409);

    const seen = await call<{ summary: Summary; expired: boolean; issuedHere: boolean }>(added, "POST", "/machine-links/inspect", { link: created.body.link });
    assert.equal(seen.status, 200);
    assert.deepEqual([seen.body.summary.issuer, seen.body.summary.own, seen.body.expired, seen.body.issuedHere], ["MacBook", true, false, false]);
    assert.equal((await call(added, "POST", "/machine-links/use", { link: created.body.link })).status, 400, "a link that twins needs the confirmation");

    const used = await call<{ steps: Step[] }>(added, "POST", "/machine-links/use", { link: created.body.link, confirmOwnedData: true });
    assert.equal(used.status, 200, JSON.stringify(used.body));
    assert.deepEqual(used.body.steps.map((step) => [step.kind, step.status]), [["relay", "done"], ["twin", "done"], ["twin", "done"], ["cluster", "done"]], JSON.stringify(used.body.steps));

    const twins = await call<{ relationships: Array<{ status: string; peer: { nodeId: string } }> }>(added, "GET", "/twins");
    assert.deepEqual(twins.body.relationships.filter((item) => item.status === "active").map((item) => item.peer.nodeId).sort(), [mac.node.nodeId, server.node.nodeId].sort());
    const clusters = await call<{ clusters: Array<{ id: string; members: Array<{ nodeId: string }> }> }>(added, "GET", "/clusters");
    assert.ok(clusters.body.clusters.find((item) => item.id === clusterId)?.members.some((member) => member.nodeId === added.node.nodeId));
    await waitForAssertion(async () => {
      const members = (await call<{ clusters: Array<{ id: string; members: Array<{ nodeId: string }> }> }>(mac, "GET", "/clusters")).body.clusters.find((item) => item.id === clusterId)?.members ?? [];
      assert.ok(members.some((member) => member.nodeId === added.node.nodeId), "the issuer sees the new member");
    }, 30_000);

    // Used once: the same link sets nothing up a second time, and says so step by step.
    const again = await call<{ steps: Step[] }>(added, "POST", "/machine-links/use", { link: created.body.link, confirmOwnedData: true });
    assert.deepEqual(again.body.steps.map((step) => [step.kind, step.status]), [["relay", "done"], ["twin", "done"], ["twin", "done"], ["cluster", "done"]]);

    // A relay that keeps invitations to its operator gives no pass; the link says what is left to do.
    assert.equal((await serving(false)).status, 204);
    await waitForAssertion(async () => assert.equal((await call<{ relays: Array<{ connected: boolean }> }>(mac, "GET", "/relays")).body.relays[0]?.connected, true), 20_000);
    const withoutPass = await call<{ summary: Summary; notes: string[] }>(mac, "POST", "/machine-links", { own: false, clusterIds: [clusterId] });
    assert.equal(withoutPass.status, 201, JSON.stringify(withoutPass.body));
    assert.deepEqual(withoutPass.body.summary.relays.map((item) => item.pass), [false]);
    assert.deepEqual(withoutPass.body.summary.twins, [], "someone else's machine is not made a twin");
    assert.equal(withoutPass.body.notes.length, 1);
    assert.equal((await call(mac, "POST", "/machine-links", { own: false, clusterIds: [] })).status, 409, "a link must do something");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
