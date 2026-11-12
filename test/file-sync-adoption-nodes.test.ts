import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { FileSyncProject } from "../src/file-sync/adoption.js";
import type { FileSyncStatusAnswer } from "../src/file-sync/index.js";
import type { PeerShareStatus, ShareStatus } from "../src/file-sync/protocol.js";
import { api, freePort, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { openNodeDatabase } from "../src/node-database.js";

/* Taking a shared project over, end to end on real nodes: two separately seeded one-node environments
   share a project whose folder already holds files on both sides, as a project that another sync tool
   moved until now does. Nobody presses anything: each node takes the project over by itself once the
   other's list of files is whole. Every file is kept whatever side held it, the same content is merged
   without being written again, a file both sides changed leaves exactly one conflict copy, and nothing
   is written on a node before its own take-over is done. Afterwards edits and deletions travel, over
   the direct listener when it can bind and through main's routes when it cannot, and idle nodes stay
   quiet. A node stopped while it could not read its folder goes on after a restart. */

const SETTLE_MS = 1_500;
const IDLE_MS = 12_000;
const SYNC_TIMEOUT_MS = 120_000;
const KINDS = ["project", "tickets", "worktrees"];
const ENGINE_TEMP = /^\.joint-bob-sync\..+\.tmp$/;
const CONFLICT_COPY = /^differs\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}\.txt$/;

type Route = PeerShareStatus["route"];

interface Side { label: string; env: DevEnvironment; node: SeededNode; session: SignedIn; root: string; child?: ChildProcess; extraEnv: Record<string, string>; lines: string[] }

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** What syncs of a tree: type, mode and content of every path outside node_modules and .git (the ignored folders the test makes). */
function synced(root: string): Map<string, string> {
  const found = new Map<string, string>();
  // The engine writes while this reads: its temps come and go, and a path can go between the listing and the look.
  const quiet = <T>(read: () => T): T | undefined => {
    try { return read(); } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
  };
  const walk = (relative: string): void => {
    for (const name of (quiet(() => readdirSync(path.join(root, relative))) ?? []).sort()) {
      const key = relative ? `${relative}/${name}` : name;
      if (key === "node_modules" || key === ".git" || ENGINE_TEMP.test(name)) continue;
      const absolute = path.join(root, key);
      const st = quiet(() => lstatSync(absolute));
      if (!st) continue;
      if (st.isSymbolicLink()) found.set(key, `link ${quiet(() => readlinkSync(absolute))}`);
      else if (st.isDirectory()) { found.set(key, `dir ${(st.mode & 0o777).toString(8)}`); walk(key); }
      else found.set(key, `file ${(st.mode & 0o777).toString(8)} ${st.size} ${quiet(() => sha(readFileSync(absolute)))}`);
    }
  };
  walk("");
  return found;
}

/** Every path under root, ignored ones included, with its inode: a file the engine wrote again has another one. */
function inodes(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (relative: string): void => {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      const key = relative ? `${relative}/${name}` : name;
      const st = lstatSync(path.join(root, key));
      found.set(key, `${st.isDirectory() ? "dir" : "file"} ${st.isDirectory() ? "" : st.size} ${st.ino}`);
      if (st.isDirectory()) walk(key);
    }
  };
  walk("");
  return found;
}

/** The engine's trash: <dataDir>/file-sync/trash/<fsId>/<day>/<shareHash>/<path>, as [path, sha256] pairs. */
function trashed(node: SeededNode): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const walk = (directory: string, segments: string[]): void => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const st = lstatSync(absolute);
      if (st.isDirectory()) walk(absolute, [...segments, name]);
      else if (st.isFile()) found.push([[...segments.slice(3), name].join("/"), sha(readFileSync(absolute))]);
    }
  };
  walk(path.join(node.dataDir, "file-sync", "trash"), []);
  return found;
}

function inTrash(node: SeededNode, relative: string, content: string): boolean {
  const wanted = sha(content);
  return trashed(node).some(([file, hash]) => hash === wanted && (file === relative || file.replace(/~\d+$/, "") === relative));
}

async function status(side: Side): Promise<FileSyncStatusAnswer> {
  const answer = await api<FileSyncStatusAnswer>(side.node, side.session, "GET", "/file-sync/status");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
}

function shareOf(answer: FileSyncStatusAnswer, projectId: string, kind = "project"): ShareStatus | undefined {
  return answer.shares.find((share) => share.projectId === projectId && share.kind === kind);
}

function peerOf(answer: FileSyncStatusAnswer, projectId: string, peer: string, kind = "project"): PeerShareStatus | undefined {
  return shareOf(answer, projectId, kind)?.peers.find((candidate) => candidate.peer === peer);
}

function requestsMade(answer: FileSyncStatusAnswer): number {
  assert.ok(answer.requests, `the status carries request counts: ${JSON.stringify(answer)}`);
  const { sent } = answer.requests;
  return sent.direct + sent.relay + sent.failed;
}

function describe(answer: FileSyncStatusAnswer, projectId: string): string {
  return JSON.stringify(answer.shares.filter((share) => share.projectId === projectId).map((share) => ({
    kind: share.kind, state: share.state, phase: share.phase, engine: share.engine, message: share.message, need: share.need, blocked: share.blocked, errors: share.errors, builtinSince: share.builtinSince,
    peers: share.peers.map((peer) => ({ caughtUp: peer.caughtUp, cursor: peer.cursor, peerMaxSeq: peer.peerMaxSeq, differences: peer.differences, builtinSince: peer.builtinSince })),
  })));
}

/** Both trees hold the same synced content and both engines are done with every folder of the project. */
async function converged(sides: [Side, Side], projectId: string, check?: (trees: [Map<string, string>, Map<string, string>]) => boolean): Promise<[FileSyncStatusAnswer, FileSyncStatusAnswer]> {
  let last: { answers: FileSyncStatusAnswer[]; trees: Array<Map<string, string>> } | undefined;
  const done = await until(async () => {
    last = { answers: await Promise.all(sides.map(status)), trees: sides.map((side) => synced(side.root)) };
    return last;
  }, ({ answers, trees }) => answers.every((answer, index) => KINDS.every((kind) => {
    const share = shareOf(answer, projectId, kind);
    return share?.state === "idle" && share.phase === "builtin" && share.need.files === 0 && share.blocked === 0 && peerOf(answer, projectId, sides[1 - index].node.nodeId, kind)?.caughtUp === true;
  })) && JSON.stringify([...trees[0]]) === JSON.stringify([...trees[1]]) && (check?.(trees as [Map<string, string>, Map<string, string>]) ?? true), SYNC_TIMEOUT_MS, 300);
  const [treeA, treeB] = done.trees;
  const onlyA = [...treeA].filter(([key, value]) => treeB.get(key) !== value);
  const onlyB = [...treeB].filter(([key, value]) => treeA.get(key) !== value);
  const said = `A ${describe(last!.answers[0], projectId)} B ${describe(last!.answers[1], projectId)}\n${lines(sides)}`;
  assert.deepEqual([onlyA.slice(0, 10), onlyB.slice(0, 10)], [[], []], `the trees differ: ${said}`);
  for (const [index, answer] of done.answers.entries()) {
    const share = shareOf(answer, projectId);
    assert.deepEqual([share?.state, share?.phase, share?.need.files, share?.blocked], ["idle", "builtin", 0, 0], `${sides[index].label}: ${said}`);
  }
  if (check) assert.ok(check(done.trees as [Map<string, string>, Map<string, string>]), `the expected change arrived: ${said}`);
  return done.answers as [FileSyncStatusAnswer, FileSyncStatusAnswer];
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

async function project(side: Side, projectId: string): Promise<FileSyncProject | undefined> {
  const answer = await api<{ projects: FileSyncProject[] }>(side.node, side.session, "GET", "/file-sync/projects");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body.projects.find((candidate) => candidate.projectId === projectId);
}

/** Polls the nodes' phase of the project until `done`; returns the distinct phases each was seen in, in order. */
async function watchPhases(sides: Side[], projectId: string, done: (projects: Array<FileSyncProject | undefined>) => boolean, timeoutMs: number): Promise<{ seen: string[][]; last: Array<FileSyncProject | undefined> }> {
  const seen = sides.map(() => [] as string[]);
  const last = await until(async () => {
    const projects = await Promise.all(sides.map((side) => project(side, projectId)));
    projects.forEach((entry, index) => { const phase = entry?.phase ?? "none"; if (seen[index].at(-1) !== phase) seen[index].push(phase); });
    return projects;
  }, done, timeoutMs, 100);
  return { seen, last };
}

const ORDER = ["none", "bootstrapping", "builtin"];
function inOrder(phases: readonly string[]): boolean {
  return phases.every((phase, index) => ORDER.includes(phase) && (index === 0 || ORDER.indexOf(phase) > ORDER.indexOf(phases[index - 1])));
}

/** The owner's word for machines on older releases, as each node's node.db holds it. */
function engineRecords(node: SeededNode, projectId: string): Array<{ mode: string; generation: number; origin: string }> {
  const db = openNodeDatabase(path.join(node.dataDir, "node.db"), { readOnly: true });
  try { return (db.prepare("SELECT mode, generation, origin FROM file_sync_engines WHERE project_id = ?").all(projectId) as Array<{ mode: string; generation: number; origin: string }>).map((row) => ({ ...row })); }
  finally { db.close(); }
}

async function startSide(side: Side): Promise<void> {
  side.child = await startDevNode(side.env, side.node, side.extraEnv);
  for (const stream of [side.child.stdout!, side.child.stderr!]) {
    stream.on("data", (chunk: Buffer) => side.lines.push(...String(chunk).split("\n").filter((line) => /File (sync|scan)|Syncthing/i.test(line)).map((line) => `${side.label}: ${line}`)));
  }
  side.session = await signIn(side.env, side.node);
}

async function restart(side: Side, between?: () => Promise<void>): Promise<void> {
  if (side.child) await stopDevNode(side.child);
  side.child = undefined;
  await between?.();
  await startSide(side);
}

const lines = (sides: Side[]): string => sides.flatMap((side) => side.lines.slice(-15)).join("\n");

async function runPair(t: TestContext, mode: "direct" | "relay", options: { unreadable?: boolean } = {}): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `file-sync-adoption-${mode}-`)));
  const sides: Side[] = [];
  try {
    const [envA, envB] = await Promise.all([seedDevEnvironment(path.join(root, "a"), 1), seedDevEnvironment(path.join(root, "b"), 1)]);
    const [portA, portB] = await Promise.all([freePort(), freePort()]);
    // No Tailscale address on a dev machine: the listener binds loopback instead, or nothing at all.
    const engine = (port: number, on: boolean) => ({
      JOINT_BOB_FILE_SYNC: on ? "1" : "0", JOINT_BOB_FILE_SYNC_SETTLE_MS: String(SETTLE_MS), JOINT_BOB_FILE_SYNC_PORT: String(port),
      JOINT_BOB_FILE_SYNC_LISTEN: mode === "direct" ? "127.0.0.1" : "none",
    });
    const a: Side = { label: "A", env: envA, node: envA.nodes[0], session: undefined as unknown as SignedIn, root: path.join(root, "project"), extraEnv: engine(portA, true), lines: [] };
    // B's file sync is off at first, so the test can put its files in place before B looks at them.
    const b: Side = { label: "B", env: envB, node: envB.nodes[0], session: undefined as unknown as SignedIn, root: "", extraEnv: engine(portB, false), lines: [] };
    sides.push(a, b);
    await Promise.all([startSide(a), startSide(b)]);
    const invitation = await api<{ link: string }>(a.node, a.session, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const accepted = await api(b.node, b.session, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));

    // What both sides hold, as another sync tool left it: the same bytes, written separately on each machine.
    const base = { "README.md": "# Adoption nodes\n", "src/index.ts": "export const answer = 41;\n", "src/util.ts": "export const util = true;\n", "docs/old.md": "old notes\n", "keep/deep/file.txt": "deep\n" };
    const ignored = { "node_modules/pkg/index.js": "module.exports = 1;\n", ".git/HEAD": "ref: refs/heads/main\n" };
    await writeFiles(a.root, { ...base, ...ignored, "only-a.txt": "only on A\n", "dir-a/nested.txt": "nested on A\n", "differs.txt": "A's version\n" });
    const created = await api<{ project: { id: string } }>(a.node, a.session, "POST", "/projects", { name: `Adoption ${mode}`, type: "personal", path: a.root, synced: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const listed = await until(() => api<{ projects: Array<{ id: string; path: string }> }>(b.node, b.session, "GET", "/projects?syncStatus=false"),
      (answer) => answer.body.projects?.some((candidate) => candidate.id === projectId) ?? false, 30_000);
    b.root = listed.body.projects?.find((candidate) => candidate.id === projectId)?.path ?? "";
    assert.ok(b.root && b.root !== a.root, `B lists the project with its own folder: ${JSON.stringify(listed.body)}`);
    await writeFiles(b.root, { ...base, ...ignored, "only-b.txt": "only on B\n", "dir-b/nested.txt": "nested on B\n", "differs.txt": "B's version\n" });
    // A leftover of the older tool's download cut short: the take-over removes it.
    await writeFile(path.join(b.root, ".syncthing.README.md.tmp"), "partial");
    const before = [inodes(a.root), inodes(b.root)];

    // No route sets a phase by hand on a node without the test switch (file-sync-builtin-nodes.test.ts uses it).
    const testPhase = await api(a.node, a.session, "POST", "/file-sync/test-phase", { projectId, phase: "builtin" });
    assert.equal(testPhase.status, 404, `no test-phase route: ${JSON.stringify(testPhase.body)}`);

    // A started taking the project over by itself, and cannot finish while B's file sync is off: it has no list from B.
    const waiting = await until(() => project(a, projectId), (entry) => entry?.phase === "bootstrapping" && Boolean(entry.phaseMessage), 60_000);
    assert.equal(waiting?.phase, "bootstrapping", `${JSON.stringify(waiting)}\n${lines(sides)}`);
    assert.match(waiting?.phaseMessage ?? "", /^Checking both machines' files/);
    assert.deepEqual([waiting?.owner, waiting?.shares], [true, KINDS]);
    const sync = await api<{ syncStatus: { state: string; message?: string; engine?: string } }>(a.node, a.session, "GET", `/projects/${projectId}/sync/status`);
    assert.deepEqual([sync.status, sync.body.syncStatus], [200, { state: "syncing", remainingFiles: 0, remainingBytes: 0, message: "Checking both machines' files", engine: "moving" }], "the project shows the take-over while it runs");
    assert.equal((await project(b, projectId))?.phase ?? "bootstrapping", "bootstrapping", "B has not taken it over either");
    await pause(3_000);
    assert.equal((await project(a, projectId))?.phase, "bootstrapping", "A does not finish without B's list");
    assert.deepEqual([...inodes(a.root)], [...before[0]], "nothing was written on A while it waits");

    // B's file sync comes on.
    if (options.unreadable) {
      // B cannot read its project folder: its take-over waits and says so; B is stopped there.
      await restart(b, async () => { b.extraEnv = engine(portB, true); await chmod(b.root, 0o000); });
      try {
        const stuck = await until(() => project(b, projectId), (entry) => entry?.phase === "bootstrapping" && /could not read/.test(entry.phaseMessage ?? ""), 90_000, 300);
        assert.equal(stuck?.phase, "bootstrapping", `${JSON.stringify(stuck)}\n${lines([b])}`);
        assert.match(stuck?.phaseMessage ?? "", /^Checking both machines' files: this machine could not read its files \(/);
        await stopDevNode(b.child!);
        b.child = undefined;
      } finally { await chmod(b.root, 0o755); }
      assert.deepEqual([...inodes(b.root)], [...before[1]], "nothing was written on B before its take-over");
      await startSide(b);
    } else {
      await restart(b, async () => { b.extraEnv = engine(portB, true); });
    }
    const moved = await watchPhases([a, b], projectId, (projects) => projects.every((entry) => entry?.phase === "builtin"), SYNC_TIMEOUT_MS);
    assert.deepEqual(moved.last.map((entry) => entry?.phase), ["builtin", "builtin"], `${JSON.stringify(moved)}\n${lines(sides)}`);
    for (const [index, phases] of moved.seen.entries()) assert.ok(inOrder(phases), `${sides[index].label} walked the phases in order: ${phases.join(" → ")}`);
    t.diagnostic(`${mode}: phases seen: A ${moved.seen[0].join(" → ")}, B ${moved.seen[1].join(" → ")}`);
    assert.deepEqual(moved.last.map((entry) => [entry?.phaseMessage, entry?.phaseError, entry?.waiting]), [[null, null, false], [null, null, false]]);

    // Every file on both sides, none deleted; the file both changed has exactly one conflict copy holding the other version.
    const copies = (tree: Map<string, string>) => [...tree.keys()].filter((key) => CONFLICT_COPY.test(key));
    const [afterA, afterB] = await converged([a, b], projectId, ([treeA]) => copies(treeA).length > 0);
    for (const side of [a, b]) {
      for (const file of [...Object.keys(base), "only-a.txt", "dir-a/nested.txt", "only-b.txt", "dir-b/nested.txt", "differs.txt"]) assert.ok(existsSync(path.join(side.root, file)), `${side.label} has ${file}`);
      assert.equal(await readFile(path.join(side.root, "only-a.txt"), "utf8"), "only on A\n");
      assert.equal(await readFile(path.join(side.root, "dir-b/nested.txt"), "utf8"), "nested on B\n");
      assert.deepEqual(trashed(side.node).filter(([file]) => !CONFLICT_COPY.test(file) && file !== "differs.txt"), [], `${side.label}: the take-over deleted and replaced nothing but the file both sides changed`);
    }
    const [copyA, copyB] = [copies(synced(a.root)), copies(synced(b.root))];
    assert.equal(copyA.length, 1, `exactly one conflict copy: ${copyA.join(", ")}`);
    assert.deepEqual(copyB, copyA);
    assert.deepEqual(new Set([await readFile(path.join(a.root, "differs.txt"), "utf8"), await readFile(path.join(a.root, copyA[0]), "utf8")]), new Set(["A's version\n", "B's version\n"]));
    // The same content on both sides was merged, not copied: those files are the very ones the test wrote. Ignored folders were left alone.
    for (const [index, side] of [a, b].entries()) {
      const now = inodes(side.root);
      for (const file of [...Object.keys(base), ...Object.keys(ignored)]) assert.equal(now.get(file), before[index].get(file), `${side.label}: ${file} was not written again`);
    }
    assert.equal(existsSync(path.join(a.root, "node_modules", "pkg", "index.js")) && existsSync(path.join(b.root, ".git", "HEAD")), true);
    assert.equal(existsSync(path.join(b.root, ".syncthing.README.md.tmp")), false, "the leftover temp is gone");
    assert.equal(existsSync(path.join(a.root, ".syncthing.README.md.tmp")), false, "and was never synced");
    for (const [index, answer] of [afterA, afterB].entries()) {
      for (const kind of KINDS) {
        const share = shareOf(answer, projectId, kind);
        assert.deepEqual([typeof share?.builtinSince, share?.engine, share?.phase], ["number", "builtin", "builtin"], `${sides[index].label} took over its ${kind}: ${describe(answer, projectId)}`);
      }
    }
    // The owner wrote the record machines on older releases follow. The other node wrote none of its own: what it holds,
    // once the owner's has reached it, is the owner's.
    const owned = [{ mode: "builtin", generation: 1, origin: a.node.nodeId }];
    assert.deepEqual(engineRecords(a.node, projectId), owned);
    assert.deepEqual(engineRecords(b.node, projectId).filter((record) => record.origin !== a.node.nodeId), []);
    const shown = await api<{ projects: Array<{ id: string; syncStatus?: { state: string; engine?: string } }> }>(b.node, b.session, "GET", "/projects?syncStatus=true");
    assert.deepEqual(shown.body.projects.find((candidate) => candidate.id === projectId)?.syncStatus, { state: "synced", remainingFiles: 0, remainingBytes: 0, message: "Files are up to date", engine: "builtin" });

    // Edits and deletions travel now; what a peer's change replaced or deleted is in the receiver's trash.
    await writeFile(path.join(a.root, "src", "index.ts"), "export const answer = 42;\n");
    await rm(path.join(b.root, "docs", "old.md"));
    await writeFiles(b.root, { "from-b.txt": "written on B\n" });
    const again = await converged([a, b], projectId, ([treeA, treeB]) => treeA.has("from-b.txt") && !treeA.has("docs/old.md") && treeB.get("src/index.ts") === treeA.get("src/index.ts"));
    assert.equal(await readFile(path.join(b.root, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
    assert.ok(inTrash(b.node, "src/index.ts", "export const answer = 41;\n"), `B keeps the version A's edit replaced: ${JSON.stringify(trashed(b.node))}`);
    assert.ok(inTrash(a.node, "docs/old.md", "old notes\n"), `A keeps the file B deleted: ${JSON.stringify(trashed(a.node))}`);

    // Requests took the expected path both ways.
    for (const [index, answer] of again.entries()) {
      const other = [b, a][index].node.nodeId;
      const route: Route | undefined = peerOf(answer, projectId, other)?.route;
      assert.equal(route, mode, `${[a, b][index].label} reached its peer ${mode === "direct" ? "over the direct listener" : "through the main server"}: ${JSON.stringify(answer.peers)}`);
      assert.equal(answer.peers.find((peer) => peer.nodeId === other)?.route, mode);
      const { requests } = answer;
      assert.ok(requests, "request counts are reported");
      if (mode === "direct") {
        assert.deepEqual(answer.origins, [`http://127.0.0.1:${index === 0 ? portA : portB}`], "the listener bound the loopback address");
        assert.ok(requests.sent.direct > 0 && requests.served.direct > 0, `direct traffic both ways: ${JSON.stringify(requests)}`);
      } else {
        assert.deepEqual(answer.origins, [], "no listener");
        assert.deepEqual([requests.sent.direct, requests.served.direct], [0, 0], `nothing direct: ${JSON.stringify(requests)}`);
        assert.ok(requests.sent.relay > 0 && requests.served.relay > 0, `relayed traffic both ways: ${JSON.stringify(requests)}`);
      }
    }

    // Idle: once the last notices and pulls are done, nothing more goes out, and no take-over is tried again.
    let quiet = await Promise.all([a, b].map(status));
    const settleDeadline = Date.now() + 20_000;
    for (;;) {
      await pause(2_000);
      const next = await Promise.all([a, b].map(status));
      const same = next.every((answer, index) => requestsMade(answer) === requestsMade(quiet[index]));
      quiet = next;
      if (same || Date.now() > settleDeadline) break;
    }
    const idleStart = quiet.map(requestsMade);
    const quietTrees = [inodes(a.root), inodes(b.root)];
    await pause(IDLE_MS);
    const idleEnd = (await Promise.all([a, b].map(status))).map(requestsMade);
    const idleRequests = idleEnd[0] - idleStart[0] + idleEnd[1] - idleStart[1];
    t.diagnostic(`${mode}: ${idleRequests} /files/* requests in ${IDLE_MS / 1000} idle seconds`);
    assert.ok(idleRequests <= 2, `idle nodes made ${idleRequests} /files/* requests in ${IDLE_MS / 1000} s (A ${idleEnd[0] - idleStart[0]}, B ${idleEnd[1] - idleStart[1]})`);
    assert.deepEqual([[...inodes(a.root)], [...inodes(b.root)]], [[...quietTrees[0]], [...quietTrees[1]]], "idle engines write nothing");
    assert.deepEqual((await Promise.all([a, b].map((side) => project(side, projectId)))).map((entry) => entry?.phase), ["builtin", "builtin"]);
    if (sides.some((side) => side.lines.length)) t.diagnostic(`log lines: ${lines(sides).split("\n").slice(-20).join(" | ")}`);
  } finally {
    for (const side of sides) if (side.root && existsSync(side.root)) await chmod(side.root, 0o755).catch(() => undefined);
    await Promise.all(sides.map((side) => side.child ? stopDevNode(side.child) : undefined));
    await rm(root, { recursive: true, force: true });
  }
}

test("two nodes take a shared project over by themselves: every file kept, the same content merged, one conflict copy, then edits travel over the direct listener", { timeout: 420_000 }, (t) => runPair(t, "direct"));

test("with the listener off the same works through the main server's routes, and a node stopped while it could not read its folder goes on after a restart", { timeout: 480_000 }, (t) => runPair(t, "relay", { unreadable: true }));
