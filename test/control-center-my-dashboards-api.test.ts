import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

/** A stand-in dashboard agent: it keeps what it was asked, then writes a one-number script dashboard titled by the request's "Title: ..." line. */
const fakeAgent = (log: string) => `import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  await appendFile(${JSON.stringify(log)}, JSON.stringify(input.prompt) + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const request = input.prompt.split("## The person's request")[1] ?? "";
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  const title = /Title: ([^\\n]+)/.exec(request)?.[1] ?? "Everything";
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title, refresh: { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } }));
  await writeFile(path.join(draft, "refresh.mjs"), "console.log(JSON.stringify({ generatedAt: new Date().toISOString(), waiting: 3 }))");
  await writeFile(path.join(draft, "index.html"), "<script>const data = JointBobKit.payload(); JointBobKit.mount(JointBobKit.kpi({ label: 'Waiting', value: data.waiting ?? 0 }))</script>");
  return "I built the dashboard.";
};
`;

interface Mine { id: string; title: string; hostProjectId: string; isDefault: boolean; status: string; refreshMethod: string | null; lastRefresh: { ok: boolean } | null; changing: boolean }
interface Message { role: string; text: string; via: string | null; importance: string; actions: Array<{ id: string; data?: { dashboardId?: string } }> }

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Never happened: ${label}`);
}

test("the control center keeps a person's dashboards over all their projects: asked for in words, several of them, one the default", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-my-dashboards-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const agent = path.join(root, "dashboard-agent.mjs"), asked = path.join(root, "asked.log");
    await writeFile(agent, fakeAgent(asked));
    const environment = await seedDevEnvironment(root, 1);
    const node: SeededNode = environment.nodes[0];
    server = await startDevNode(environment, node, { JOINT_BOB_DASHBOARD_AGENT: agent });
    const auth: SignedIn = await signIn(environment, node);
    const mine = async () => (await api<{ dashboards: Mine[] }>(node, auth, "GET", "/control-center/dashboards/overview")).body.dashboards;
    const timeline = async () => (await api<{ messages: Message[] }>(node, auth, "GET", "/control-center/bob/messages")).body.messages;
    const ready = (title: string) => eventually(async () => (await mine()).find((dashboard) => dashboard.title === title && dashboard.status === "ready" && !dashboard.changing && dashboard.lastRefresh?.ok), `"${title}" is ready with data`);

    assert.deepEqual(await mine(), [], "nothing yet");
    assert.equal((await api(node, auth, "POST", "/control-center/dashboards/overview", { text: " " })).status, 400, "it needs the person's words");

    // Asked for in words: Bob answers at once, the agent builds it over every project, and it is the default as the first one.
    const first = await api<{ id: string; reply: Message }>(node, auth, "POST", "/control-center/dashboards/overview", { text: "what needs my attention everywhere\nTitle: Attention" });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.match(first.body.reply.text, /^Building your control center dashboard\./);
    assert.equal((await mine()).find((dashboard) => dashboard.id === first.body.id)?.status, "building");
    const attention = await ready("Attention");
    assert.deepEqual([attention.id, attention.isDefault, attention.refreshMethod], [first.body.id, true, "script"]);
    const done = await eventually(async () => (await timeline()).find((message) => message.text.startsWith('Done. "Attention" is ready for the control center.')), "Bob says it is ready");
    assert.equal(done.actions.find((action) => action.id === "dashboards.open")?.data?.dashboardId, attention.id, "its button opens this dashboard");
    const prompt = JSON.parse((await readFile(asked, "utf8")).split("\n")[0]) as string;
    assert.match(prompt, /## This account dashboard/);
    assert.match(prompt, /This dashboard covers every project and workspace the person can see, not one of them:/);
    for (const project of node.projects) assert.ok(prompt.includes(`- ${project.name}: `), `the agent is told about ${project.name}`);

    // A second one is kept beside it, and the default stays the person's choice until they change it.
    const second = await api<{ id: string }>(node, auth, "POST", "/control-center/dashboards/overview", { text: "spend per project this week\nTitle: Spend" });
    assert.equal(second.status, 202, JSON.stringify(second.body));
    const spend = await ready("Spend");
    assert.deepEqual((await mine()).map((dashboard) => [dashboard.title, dashboard.isDefault]), [["Attention", true], ["Spend", false]], "the default first");
    assert.equal((await api(node, auth, "POST", `/dashboards/${spend.id}/activate`, { projectId: spend.hostProjectId })).status, 200);
    assert.deepEqual((await mine()).map((dashboard) => [dashboard.title, dashboard.isDefault]), [["Spend", true], ["Attention", false]]);

    // They are shown in the Dashboard view, not as cards of the Dashboards tab, and their page and data are the ordinary dashboard's.
    assert.deepEqual((await api<{ dashboards: unknown[] }>(node, auth, "GET", "/control-center/dashboards")).body.dashboards, []);
    const detail = await api<{ dashboard: { approved: boolean; entity: { kind: string } } }>(node, auth, "GET", `/dashboards/${spend.id}?projectId=${spend.hostProjectId}`);
    assert.deepEqual([detail.status, detail.body.dashboard.approved, detail.body.dashboard.entity.kind], [200, true, "account"]);
    const frame = await fetch(`${node.url}/api/dashboards/${spend.id}/frame?projectId=${spend.hostProjectId}&theme=dark`, { headers: { cookie: auth.cookie } });
    assert.equal(frame.status, 200);
    assert.match(await frame.text(), /"waiting":3/);

    // Nobody else's: another account's dashboards cannot be listed.
    assert.equal((await api(node, auth, "GET", `/dashboards?kind=account&id=${"f".repeat(32)}&projectId=${spend.hostProjectId}`)).status, 404);

    // Ask Bob to change one: the agent edits it and Bob says so.
    const change = await api(node, auth, "POST", `/control-center/dashboards/${attention.id}/ask-bob`, { text: "add what waits for review\nTitle: Attention and reviews" });
    assert.equal(change.status, 202, JSON.stringify(change.body));
    await ready("Attention and reviews");
    await eventually(async () => (await timeline()).find((message) => message.text.startsWith('Done. I changed "Attention and reviews".')), "Bob says it changed");

    // Deleting the default leaves the other as the default.
    assert.equal((await api(node, auth, "DELETE", `/dashboards/${spend.id}?projectId=${spend.hostProjectId}`)).status, 200);
    assert.deepEqual((await mine()).map((dashboard) => [dashboard.title, dashboard.isDefault]), [["Attention and reviews", true]]);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
