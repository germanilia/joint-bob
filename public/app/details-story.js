// Top-level Story pane inside the desktop details panel: reads the saved Change Story
// inline (Overview + flow diagram, Conversation, Examples, Implementation) without forcing
// a separate modal, and links directly to full generation and top-bar podcast playback.
import { api } from "./api.js";
import { elements } from "./elements.js";
import { openConversationStory, openGitReview } from "./git-review.js";
import { selectStoryPull, storyMarkdown } from "./git-story.js";
import { projectGitUrl } from "./project-git-url.js";
import { toast } from "./shell.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";
import { voiceForThisNode } from "./voice-choice.js";

const byId = (id) => document.getElementById(id);

const view = {
  key: "",
  generation: 0,
  section: "overview",
  loading: false,
  error: "",
  latest: null,
  commits: [],
  pendingPull: null,
};

let onOpenFile = null;

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function currentTarget() {
  return {
    projectId: state.activeConversationProjectId || state.activeProjectId,
    nodeId: state.activeNodeId,
  };
}

function currentConversationId() {
  const session = activeChatSession();
  return session?.conversationId ?? session?.id ?? state.activeConversationId ?? null;
}

function ago(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

function renderFlowDiagram(diagram) {
  if (!diagram?.nodes?.length) return null;
  const box = el("div", "ws-story-diagram");
  box.append(el("div", "ws-story-diagram-label", "Flow"));
  const edgesByFrom = new Map();
  for (const edge of diagram.edges || []) {
    if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
    edgesByFrom.get(edge.from).push(edge);
  }
  diagram.nodes.slice(0, 8).forEach((node, index) => {
    const item = el("div", `ws-flow-node${node.kind === "decision" ? " is-decision" : ""}`);
    item.append(el("b", "", `${index + 1}. ${node.label}`));
    if (node.file) item.append(el("small", "", node.file));
    box.append(item);
    const outgoing = edgesByFrom.get(node.id);
    if (outgoing?.length && index < Math.min(diagram.nodes.length, 8) - 1) {
      const label = outgoing[0].label ? `↓ ${outgoing[0].label}` : "↓";
      box.append(el("div", "ws-flow-arrow", label));
    }
  });
  return box;
}

function renderSectionBody(saved) {
  const written = saved.story;
  const facts = saved.facts || { files: [] };
  const wrap = el("div", "ws-story-section");

  if (view.section === "overview") {
    const hero = el("div", "ws-story-hero");
    hero.append(el("h4", "", written.title || "Change story"));
    if (written.overview?.what) hero.append(el("p", "", written.overview.what));
    if (written.overview?.why) {
      const why = el("p", "ws-story-why");
      why.append(el("strong", "", "Why: "), document.createTextNode(written.overview.why));
      hero.append(why);
    }
    if (written.overview?.notice?.length) {
      const ul = el("ul", "ws-story-bullets");
      for (const note of written.overview.notice) ul.append(el("li", "", note));
      hero.append(ul);
    }
    wrap.append(hero);

    const diagram = renderFlowDiagram(written.diagram);
    if (diagram) wrap.append(diagram);

    const promo = el("div", "ws-card ws-story-podcast-bar");
    promo.append(el("span", "ws-pane-note", "Want the two-host audio walkthrough?"));
    const playBtn = el("button", "ws-btn-sm is-primary", "Play in top bar ▶");
    playBtn.type = "button";
    playBtn.addEventListener("click", () => elements.activityOverviewButton?.click());
    promo.append(playBtn);
    wrap.append(promo);
    return wrap;
  }

  if (view.section === "conversation") {
    const card = el("div", "ws-card");
    const phases = written.timeline || [];
    if (!phases.length) {
      card.append(el("p", "ws-card-empty", "No conversation timeline recorded for this story."));
    } else {
      const rows = el("div", "ws-card-rows");
      for (const phase of phases) {
        const row = el("div", "ws-git-row");
        const top = el("div", "ws-git-row-top");
        const turns = phase.turns?.length > 1 ? `Turns ${phase.turns[0]}–${phase.turns.at(-1)}` : phase.turns?.length === 1 ? `Turn ${phase.turns[0]}` : "";
        top.append(el("span", "ws-git-row-title", phase.title || "Phase"));
        if (turns) top.append(el("span", "ws-badge is-muted", turns));
        row.append(top);
        if (phase.summary) row.append(el("div", "ws-git-row-sub", phase.summary));
        if (phase.pivot) row.append(el("div", "ws-git-row-sub ws-story-pivot", `Changed direction: ${phase.pivot}`));
        rows.append(row);
      }
      card.append(rows);
    }
    wrap.append(card);
    return wrap;
  }

  if (view.section === "examples") {
    const card = el("div", "ws-card");
    const examples = written.examples || [];
    if (!examples.length) {
      card.append(el("p", "ws-card-empty", "No behavioral examples recorded."));
    } else {
      const rows = el("div", "ws-card-rows");
      const tones = { "Happy path": "is-live", "Edge case": "is-amber", Failure: "is-danger", Navigation: "is-indigo" };
      for (const ex of examples) {
        const row = el("div", "ws-git-row");
        const top = el("div", "ws-git-row-top");
        top.append(el("span", "ws-git-row-title", ex.title || "Example"));
        if (ex.kind) top.append(el("span", `ws-badge ${tones[ex.kind] || "is-muted"}`, ex.kind));
        row.append(top);
        if (ex.result) row.append(el("div", "ws-git-row-sub", ex.result));
        rows.append(row);
      }
      card.append(rows);
    }
    wrap.append(card);
    return wrap;
  }

  // Implementation
  const card = el("div", "ws-card");
  const files = facts.files || [];
  if (!files.length) {
    card.append(el("p", "ws-card-empty", "No changed files recorded in this story."));
  } else {
    const rows = el("div", "ws-card-rows");
    for (const file of files) {
      const btn = el("button", "ws-git-row");
      btn.type = "button";
      const top = el("div", "ws-git-row-top");
      const slash = file.path.lastIndexOf("/");
      top.append(
        el("span", "ws-git-row-title", slash >= 0 ? file.path.slice(slash + 1) : file.path),
        el("span", "ws-badge is-muted", `+${file.add ?? 0} −${file.del ?? 0}`),
      );
      btn.append(top);
      const what = written.implementation?.what?.[file.path] || (slash >= 0 ? file.path.slice(0, slash) : "");
      if (what) btn.append(el("div", "ws-git-row-sub", what));
      btn.addEventListener("click", () => onOpenFile?.(file.path));
      rows.append(btn);
    }
    card.append(rows);
  }
  wrap.append(card);
  return wrap;
}

function launchStoryWriter(pullNumber = null, pullUrl = null) {
  const session = activeChatSession();
  const conversationId = session?.conversationId ?? session?.id ?? null;
  if (!conversationId && !pullNumber) { toast("Open a conversation first"); return; }
  if (pullNumber) {
    void openGitReview(conversationId, { tab: "story" }).then(() => {
      selectStoryPull(pullNumber, pullUrl);
    });
    return;
  }
  voiceForThisNode()
    .then((settings) => settings && openConversationStory(conversationId))
    .catch((error) => toast.error(error.message));
}

function render() {
  const host = byId("detailsStoryHost");
  const statusEl = byId("detailsStoryStatus");
  if (!host) return;
  host.replaceChildren();

  if (view.loading) {
    if (statusEl) statusEl.textContent = "Loading…";
    host.append(el("p", "ws-pane-note", "Loading this conversation's story…"));
    return;
  }
  if (view.error) {
    if (statusEl) statusEl.textContent = "";
    host.append(el("p", "ws-pane-note", view.error));
    return;
  }
  if (!currentTarget().projectId || !currentConversationId()) {
    if (statusEl) statusEl.textContent = "";
    host.append(el("p", "ws-pane-note", "Open a conversation to read or write its change story."));
    return;
  }

  if (!view.latest) {
    if (statusEl) statusEl.textContent = "Not written yet";
    const card = el("div", "ws-story-hero");
    card.append(
      el("h4", "", view.pendingPull ? `Explain PR #${view.pendingPull.number}` : "Change story"),
      el("p", "", "What changed, how it flows, examples, and implementation notes — written in a separate read-only reviewer session without interrupting this conversation."),
    );
    const actions = el("div", "ws-inline-toolbar");
    const writeBtn = el("button", "ws-btn-sm is-primary", view.pendingPull ? `Write story for PR #${view.pendingPull.number}` : "Write story");
    writeBtn.type = "button";
    writeBtn.dataset.testid = "details-story-write";
    writeBtn.addEventListener("click", () => launchStoryWriter(view.pendingPull?.number ?? null, view.pendingPull?.url ?? null));
    const podcastBtn = el("button", "ws-btn-sm", "Listen in top bar");
    podcastBtn.type = "button";
    podcastBtn.addEventListener("click", () => elements.activityOverviewButton?.click());
    actions.append(writeBtn, podcastBtn);
    card.append(actions);
    host.append(card);
    return;
  }

  const { saved, freshness, thread } = view.latest;
  const fresh = Boolean(freshness?.fresh);
  if (statusEl) statusEl.textContent = `${fresh ? "Up to date" : "Outdated"}${thread?.updatedAt ? ` · ${ago(thread.updatedAt)}` : ""}`;

  // Toolbar: source pill, Copy Markdown, Refresh/Regenerate
  const toolbar = el("div", "ws-inline-toolbar");
  const fileCount = saved.facts?.files?.length ?? 0;
  toolbar.append(el("span", `ws-badge ${fresh ? "is-live" : "is-amber"}`, `${fileCount} file${fileCount === 1 ? "" : "s"}`));
  const copyBtn = el("button", "ws-btn-sm", "Copy MD");
  copyBtn.type = "button";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(storyMarkdown(saved));
      toast("Copied story as Markdown");
    } catch { toast.error("Could not copy to clipboard"); }
  });
  const refreshBtn = el("button", "ws-btn-sm", "↻");
  refreshBtn.type = "button";
  refreshBtn.title = "Refresh story";
  refreshBtn.addEventListener("click", () => void refreshDetailsStory({ force: true }));
  toolbar.append(copyBtn, refreshBtn);
  host.append(toolbar);

  // Story section sub-tabs
  const subtabs = el("div", "ws-subtabs");
  subtabs.setAttribute("role", "tablist");
  subtabs.setAttribute("aria-label", "Story sections");
  for (const [id, label] of [
    ["overview", "Overview"],
    ["conversation", "Conversation"],
    ["examples", "Examples"],
    ["implementation", "Implementation"],
  ]) {
    const tab = el("button", "ws-subtab", label);
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(view.section === id));
    tab.addEventListener("click", () => { view.section = id; render(); });
    subtabs.append(tab);
  }
  host.append(subtabs, renderSectionBody(saved));
}

export async function refreshDetailsStory({ force = false, pullNumber = null, pullUrl = null } = {}) {
  if (pullNumber) view.pendingPull = { number: pullNumber, url: pullUrl };
  const where = currentTarget();
  const conversationId = currentConversationId();
  const nextKey = `${where.projectId || ""}|${where.nodeId || ""}|${conversationId || ""}`;
  if (!where.projectId || !conversationId) {
    view.key = "";
    view.latest = null;
    view.loading = false;
    view.error = "";
    render();
    return;
  }
  if (!force && nextKey === view.key && !view.loading) {
    render();
    return;
  }
  view.key = nextKey;
  const gen = ++view.generation;
  view.loading = true;
  view.error = "";
  render();
  try {
    const body = await api(projectGitUrl(where, "story-latest", { conversationId }));
    if (gen !== view.generation) return;
    view.commits = body.commits ?? [];
    view.latest = body.latest ?? null;
    view.loading = false;
  } catch (error) {
    if (gen !== view.generation) return;
    view.latest = null;
    view.loading = false;
    view.error = error.cause?.message || error.message;
  }
  render();
}

export function resetDetailsStory() {
  view.key = "";
  view.generation += 1;
  view.latest = null;
  view.loading = false;
  view.error = "";
  view.pendingPull = null;
  render();
}

export function initDetailsStory({ openFile } = {}) {
  onOpenFile = openFile ?? null;
  // Refresh inline Story when the full story dialog closes (e.g. after generating).
  elements.gitReviewDialog?.addEventListener("close", () => {
    if (!byId("detailsStory")?.hidden) void refreshDetailsStory({ force: true });
  });
}
