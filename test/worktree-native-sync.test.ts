import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, freePort, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

type Worktree = { id: string; name: string; path: string };

test("a worktree reaches the other node through built-in sync, keeps heavy files out, and its deletion removes it there", { timeout: 360_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "worktree-native-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    await rm(path.join(b.home, ".pi", "sessions"), { recursive: true, force: true });
    await rm(path.join(b.home, ".claude", "projects"), { recursive: true, force: true });
    // File sync is on, and each node takes the project over by itself once it is shared.
    for (const [env, node] of [[a, left], [b, right]] as const) {
      children.push(await startDevNode(env, node, { JOINT_BOB_FILE_SYNC: "1", JOINT_BOB_FILE_SYNC_SETTLE_MS: "1500", JOINT_BOB_FILE_SYNC_PORT: String(await freePort()), JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1" }));
    }
    const sa = await signIn(a, left), sb = await signIn(b, right);
    const invitation = await api<{ link: string }>(left, sa, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal((await api(right, sb, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);

    const directory = path.join(root, "project");
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "src", "inbox.ts"), "export const inbox = 'mock';\n");
    const created = await api<{ project: { id: string } }>(left, sa, "POST", "/projects", { name: "Worktree native", type: "personal", path: directory, synced: true });
    assert.equal(created.status, 201);
    const projectId = created.body.project.id;

    const made = await api<{ worktree: Worktree }>(left, sa, "POST", `/projects/${projectId}/worktrees`, { name: "Native slice" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const source = made.body.worktree;
    await mkdir(path.join(source.path, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(source.path, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await writeFile(path.join(source.path, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    await writeFile(path.join(source.path, "src", "later.ts"), "export const later = true;\n");

    /** What file sync says on both nodes, for a failure's message. */
    const describeSync = async (): Promise<string> => JSON.stringify(await Promise.all(([[left, sa], [right, sb]] as const).map(async ([node, session]) => ({
      project: (await api<{ projects: Array<{ projectId: string }> }>(node, session, "GET", "/file-sync/projects")).body.projects?.find((entry) => entry.projectId === projectId),
      shares: (await api<{ shares: Array<Record<string, unknown>> }>(node, session, "GET", "/file-sync/status")).body.shares
        ?.filter((share) => share.projectId === projectId).map((share) => ({ share: share.share, state: share.state, phase: share.phase, message: share.message, need: share.need, blocked: share.blocked, errors: share.errors, peers: share.peers })),
    }))));
    // The worktree is listed on the other node as soon as its description arrives. Its files are not downloaded for a node
    // that never used it, and listing it writes nothing into it.
    let remote: Worktree | undefined;
    const listed = await until(async () => {
      remote = (await api<{ worktrees: Worktree[] }>(right, sb, "GET", `/projects/${projectId}/worktrees`)).body.worktrees?.find((worktree) => worktree.id === source.id);
      return Boolean(remote);
    }, 90_000);
    assert.equal(listed, true, `the worktree is listed on the other node: ${listed ? "" : await describeSync()}`);
    assert.equal(remote!.name, "Native slice");
    assert.equal(await exists(path.join(remote!.path, ".joint-bob-worktree", "nodes", `${right.nodeId}.json`)), false, "listing a worktree writes nothing into it");

    // A conversation opens in it there (its agent instructions are read): from now on its files are downloaded.
    const used = await api(right, sb, "GET", `/projects/${projectId}/instructions/content?worktreeId=${source.id}`);
    assert.equal(used.status, 200, JSON.stringify(used.body));
    const arrived = await until(async () => await exists(path.join(remote!.path, "src", "later.ts")) && await exists(path.join(remote!.path, "src", "inbox.ts")), 90_000);
    assert.equal(arrived, true, `the worktree's files and files added to it later reach the node that uses it: ${arrived ? "" : await describeSync()}`);
    assert.equal(await readFile(path.join(remote!.path, "src", "inbox.ts"), "utf8"), "export const inbox = 'mock';\n");
    assert.equal(await exists(path.join(remote!.path, "node_modules")), false, "packages never travel");
    assert.equal(await exists(path.join(remote!.path, "logo.png")), false, "binaries never travel");

    // The other node installs its own packages and records a conversation there.
    await mkdir(path.join(remote!.path, "node_modules", "local"), { recursive: true });
    await writeFile(path.join(remote!.path, "node_modules", "local", "x.js"), "local only\n");
    const marker = path.join(remote!.path, ".joint-bob-worktree", "conversations", "pi--remote-conversation.json");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "{}\n");
    assert.equal(await until(() => exists(path.join(source.path, ".joint-bob-worktree", "conversations", "pi--remote-conversation.json")), 90_000), true, "conversation markers travel back");
    // A node records its path when it uses the worktree, not when it lists it: a listing's write landing after another
    // node's delete used to bring the deleted folder back. Both nodes use it now, so each holds the other's.
    assert.equal(await until(() => exists(path.join(remote!.path, ".joint-bob-worktree", "nodes", `${left.nodeId}.json`)), 90_000), true, "the node that created the worktree publishes its path there");
    assert.equal(await until(() => exists(path.join(source.path, ".joint-bob-worktree", "nodes", `${right.nodeId}.json`)), 90_000), true, "the node that started using it publishes its path too");

    const removed = await fetch(`${left.url}/api/projects/${projectId}/worktrees/${source.id}`, { method: "DELETE", headers: { Cookie: sa.cookie, "x-csrf-token": sa.csrfToken } });
    assert.equal(removed.status, 204);
    assert.equal(await until(async () => !await exists(remote!.path), 120_000), true, "deleting the worktree removes it on the other node, ignored packages included");
    assert.deepEqual((await api<{ worktrees: Worktree[] }>(right, sb, "GET", `/projects/${projectId}/worktrees`)).body.worktrees, []);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
