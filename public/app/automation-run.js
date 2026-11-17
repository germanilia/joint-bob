// Automation editor, Run tab: where each run happens (a new conversation in the project, one
// conversation, or a personal assistant), on which machine, with which harness, model, reasoning and
// subscription pool, what happens around the run, and the optional auto reply.
import { harnessOption } from "../harness-metadata.js";
import { card, field, input, segmented, select, switchRow, textarea } from "./automation-trigger.js";
import { fillModelOptions, fillThinkingOptions, selectedModel } from "./git-reviewer-options.js";
import { createAutomationPoolPicker, createAutomationProfilePicker } from "./provider-profile-picker.js";
import { makeNode } from "./relay-ui.js";
import { state } from "./state.js";

/** Used when the server offers no auto reply defaults: the person writes the instructions. */
const ownerLabel = (owner) => `${owner.name} (${owner.local ? "this machine" : owner.twin ? "twin" : "shared machine"})`;

export function createRunTab(ctx) {
  const element = makeNode("div", "atab");
  element.addEventListener("input", () => ctx.markDirty());
  element.addEventListener("change", () => ctx.markDirty());
  let assistantId = null;
  let wantedSession = "";
  let conversationsKey = "";
  let auto = null; // { harnesses, defaults }, loaded once
  let autoReady = false;

  // Where it runs
  const kind = segmented("automation-target", [["project", "A new conversation each time in the project"], ["conversation", "One conversation"], ["assistant", "A personal assistant"]], () => { syncKind(); ctx.markDirty(); });
  const conversation = select();
  const conversationField = field("Conversation", conversation, "automation-conversation", "Each run adds to this conversation when Fresh worktree is off; with it on, each run starts its own conversation.");
  const assistantNote = makeNode("p", "atab-hint", "Every run routes through the personal assistant, and its decision model chooses the conversation. Its own settings decide the harness, model and reasoning.");
  const machine = select();
  const harness = select();
  const model = select();
  const reasoning = select();
  const machineField = field("Execution machine", machine, "automation-machine", "The machine that stores and runs it.");
  const harnessField = field("Harness", harness, "automation-harness");
  const modelField = field("Model", model, "automation-model");
  const reasoningField = field("Reasoning", reasoning, "automation-reasoning");
  const grid = makeNode("div", "atab-grid");
  grid.append(machineField, harnessField, modelField, reasoningField);
  const pool = createAutomationPoolPicker(reasoningField, "automation-pool", () => ctx.api(ctx.endpoint("/profiles")));
  const worktree = switchRow("Fresh worktree each run", "Starts from origin/main in a temporary worktree and removes it after the run. Each run starts its own conversation.", "automation-worktree");
  const preserve = switchRow("Keep files between runs", "Leaves the run's files in place for the next run. Only without a fresh worktree.", "automation-preserve-files");
  const where = card("Where and with what", "", kind.element, conversationField, assistantNote, grid, worktree.row, preserve.row);

  // Around the run
  const pauseOnFailure = switchRow("Turn the automation off after a failed run", "Off tries again at the next scheduled time or call.", "automation-pause-on-failure");
  const markForReview = switchRow("Count completed runs toward Needs review", "", "automation-mark-for-review");
  const hideFromHistory = switchRow("Hide from conversation history", "Even when “Show automations” is on.", "automation-hide-from-history");
  const bypass = switchRow("Bypass Guardian for this automation's turns", "Enforced rules, relay rules and team safeguards still apply.", "automation-bypass-guardian");
  const after = card("After the run", "", pauseOnFailure.row, markForReview.row, hideFromHistory.row, bypass.row);

  // Auto reply
  const autoSwitch = switchRow("Auto reply", "A second agent keeps the conversation going until your stop criteria, the reply limit or a manual Stop. Retries may incur model costs.", "automation-autoreply-switch", true);
  const arHarness = select();
  const arModel = select();
  const arThinking = select();
  const arInstructions = textarea(3);
  const arStop = textarea(3);
  const arLimit = input("number", { min: 1, step: 1, placeholder: "Unlimited" });
  const arTools = switchRow("Let the responder inspect files and run checks", "", "automation-autoreply-tools");
  const arThinkingField = field("Responder reasoning", arThinking, "automation-autoreply-reasoning");
  const arGrid = makeNode("div", "atab-grid");
  arGrid.append(field("Responder harness", arHarness, "automation-autoreply-harness"), field("Responder model", arModel, "automation-autoreply-model"), arThinkingField);
  const arProfile = createAutomationProfilePicker(arThinkingField, "automation-autoreply-profile", () => ctx.api(ctx.endpoint("/profiles")));
  const arBody = makeNode("div", "atab-stack");
  arBody.append(arGrid,
    field("Instructions", arInstructions, "automation-autoreply-instructions"),
    field("Stop only when", arStop, "automation-autoreply-stop"),
    field("Maximum replies", arLimit, "automation-autoreply-limit"),
    arTools.row);
  const autoReply = card("Auto reply", "", autoSwitch.row, arBody);

  element.append(where, after, autoReply);

  // ---- harness, model and reasoning ----

  function fillHarnesses(engine, modelKey, effort) {
    const { harnesses } = ctx.state.options;
    harness.replaceChildren(new Option("Machine default", ""), ...harnesses.map((item) => new Option(item.label, item.id)));
    if (engine && !harnesses.some(({ id }) => id === engine)) harness.add(new Option(`${engine} (unavailable)`, engine));
    harness.value = engine;
    renderExecution(modelKey, effort);
  }

  function renderExecution(modelKey = "", effort = "") {
    const { harnesses, models } = ctx.state.options;
    const engine = harness.value || harnesses[0]?.id;
    const available = models.filter((item) => item.harnessId === engine);
    const choices = [new Option("Harness default", ""), ...available.map((item) => new Option(item.label, `${item.provider}|${item.id}`))];
    if (modelKey && !choices.some((option) => option.value === modelKey)) choices.push(new Option(`${modelKey.split("|")[1]} (unavailable)`, modelKey));
    model.replaceChildren(...choices);
    model.value = modelKey;
    const selected = available.find((item) => `${item.provider}|${item.id}` === modelKey);
    const levels = [...(selected?.thinkingLevels?.length ? selected.thinkingLevels : harnesses.find((item) => item.id === engine)?.thinkingLevels || [])];
    if (effort && !levels.includes(effort)) levels.push(effort);
    reasoning.replaceChildren(new Option("Harness default", ""), ...levels.filter((level) => level !== "default").map((level) => new Option(level, level)));
    reasoning.value = effort;
  }

  function renderMachine() {
    const { owners } = ctx.state.options;
    machine.replaceChildren(...owners.map((owner) => new Option(ownerLabel(owner), owner.id)));
    machine.value = ctx.state.nodeId || owners.find((owner) => owner.local).id;
  }

  // ---- conversations ----

  /** A conversation runs on its own harness, so picking one sets the harness. */
  function syncConversationHarness() {
    const engine = conversation.selectedOptions[0]?.dataset.engine || "";
    if (engine !== harness.value) fillHarnesses(engine, "", "");
  }

  /** Conversations an automation can write to: live ones, not read-only copies. */
  async function loadConversations() {
    const projectId = ctx.state.projectId;
    const key = `${ctx.state.nodeId}|${projectId}`;
    if (key === conversationsKey) return;
    conversationsKey = key;
    try {
      const { sessions } = await ctx.api(ctx.endpoint(`/projects/${encodeURIComponent(projectId)}/sessions`));
      if (key !== conversationsKey) return;
      const usable = sessions.filter((session) => !session.readOnly && !session.doneAt);
      const keep = conversation.value || wantedSession;
      conversation.replaceChildren(...(usable.length ? usable.map((session) => {
        const option = new Option(session.title || session.firstMessage || session.id, session.id);
        option.dataset.engine = session.harnessId;
        return option;
      }) : [new Option("No conversations in this project", "")]));
      if (usable.some((session) => session.id === keep)) conversation.value = keep;
      syncConversationHarness();
    } catch (error) {
      conversationsKey = "";
      ctx.say(error.message, "error");
    }
  }

  function syncKind() {
    const picked = kind.value();
    const isConversation = picked === "conversation";
    const isAssistant = picked === "assistant";
    conversationField.hidden = !isConversation;
    assistantNote.hidden = !isAssistant;
    harness.disabled = isConversation || isAssistant;
    for (const node of [harnessField, modelField, reasoningField, preserve.row]) node.hidden = isAssistant;
    preserve.input.disabled = worktree.input.checked;
    machine.disabled = Boolean(ctx.state.item) || isAssistant;
    if (isConversation) void loadConversations();
  }

  // ---- auto reply ----

  async function loadAuto() {
    if (!state.harnesses.length) state.harnesses = (await ctx.api("/api/harnesses")).harnesses;
    auto ??= { harnesses: state.harnesses.filter((item) => item.runtimeConfigured), defaults: await ctx.api("/api/auto-respond/defaults") };
  }

  const autoHarness = () => auto.harnesses.find((item) => item.id === arHarness.value);

  /** Never pass null as `preferred`: fillModelOptions only defaults undefined. */
  function fillAutoReplyModels(saved) {
    const picked = autoHarness();
    if (picked) fillModelOptions(picked, ctx.state.options.models, arModel, arThinking, saved ?? {});
  }

  function editAutoReply(saved) {
    arHarness.replaceChildren(...auto.harnesses.map(harnessOption));
    const wanted = saved?.harnessId ?? harness.value;
    arHarness.value = auto.harnesses.some((item) => item.id === wanted) ? wanted : auto.harnesses[0].id;
    fillAutoReplyModels(saved);
    autoSwitch.input.checked = Boolean(saved);
    arBody.hidden = !saved;
    arInstructions.value = saved?.instructions ?? auto.defaults.instructions;
    arStop.value = saved?.stopInstructions ?? auto.defaults.stopInstructions;
    arLimit.value = saved ? saved.maxResponses ?? "" : auto.defaults.maxResponses;
    arTools.input.checked = saved?.useTools !== false;
    void arProfile.refresh(saved?.providerProfileId ?? null);
  }

  function readAutoReply() {
    if (!autoSwitch.input.checked) return null;
    const picked = autoHarness();
    if (!picked) throw new Error("Choose an auto reply harness");
    const instructions = arInstructions.value.trim();
    if (!instructions) throw new Error("Write instructions for auto reply");
    const { provider, modelId } = selectedModel(arModel);
    return {
      providerProfileId: arProfile.value(), harnessId: picked.id,
      provider: provider || picked.configuration?.fixedProvider || picked.defaults.provider, modelId,
      thinkingLevel: arThinking.value, instructions,
      stopInstructions: arStop.value.trim(),
      maxResponses: arLimit.value ? Number(arLimit.value) : null,
      useTools: arTools.input.checked,
    };
  }

  // ---- events ----

  machine.addEventListener("change", () => ctx.run(() => ctx.setNode(machine.value)));
  harness.addEventListener("change", () => renderExecution());
  model.addEventListener("change", () => renderExecution(model.value));
  conversation.addEventListener("change", syncConversationHarness);
  worktree.input.addEventListener("change", syncKind);
  autoSwitch.input.addEventListener("change", () => { arBody.hidden = !autoSwitch.input.checked; });
  arHarness.addEventListener("change", () => fillAutoReplyModels());
  arModel.addEventListener("change", () => fillThinkingOptions(autoHarness(), ctx.state.options.models, arModel, arThinking, arThinking.value));

  return {
    element,
    fill(item, defaults) {
      const target = item?.target ?? defaults?.target;
      assistantId = target?.kind === "assistant" ? target.assistantId : null;
      kind.hide("assistant", !assistantId);
      kind.disable(Boolean(assistantId));
      kind.set(target?.kind ?? "project");
      wantedSession = target?.kind === "conversation" ? target.sessionId : "";
      conversationsKey = "";
      conversation.replaceChildren();
      renderMachine();
      machineField.lastChild.textContent = item ? "Use Transfer in the ⋯ menu to move it." : "The machine that stores and runs it.";
      fillHarnesses(target?.kind === "assistant" ? "" : target?.engine ?? "", item?.model ? `${item.model.provider}|${item.model.modelId}` : "", item?.reasoning ?? "");
      void pool.refresh(item);
      worktree.input.checked = item?.runInWorktree ?? true;
      preserve.input.checked = item?.preserveFiles ?? false;
      pauseOnFailure.input.checked = item?.pauseOnFailure ?? false;
      markForReview.input.checked = item?.markForReview ?? false;
      hideFromHistory.input.checked = item?.hideFromHistory ?? false;
      bypass.input.checked = item?.bypassGuardian ?? false;
      syncKind();
      autoReady = false;
      loadAuto().then(() => { editAutoReply(item?.autoRespond ?? null); autoReady = true; }).catch((error) => ctx.say(error.message, "error"));
    },
    read(shared) {
      const picked = kind.value();
      const projectId = shared.projectId;
      if (picked === "conversation" && !conversation.value) throw new Error("Choose the conversation each run adds to");
      if (!autoReady) throw new Error("Auto reply settings are still loading");
      const target = picked === "assistant" ? { kind: "assistant", projectId, assistantId }
        : picked === "conversation" ? { kind: "conversation", projectId, sessionId: conversation.value, engine: conversation.selectedOptions[0].dataset.engine }
          : { kind: "project", projectId, ...(harness.value ? { engine: harness.value } : {}) };
      const [provider, modelId] = model.value.split("|");
      const chosenModel = picked !== "assistant" && modelId ? { provider, modelId } : null;
      const chosenReasoning = picked === "assistant" ? null : reasoning.value || null;
      // With the machine default harness, a model or reasoning choice is pinned to the first harness so it cannot land on another one.
      if (target.kind === "project" && !target.engine && (chosenModel || chosenReasoning)) target.engine = ctx.state.options.harnesses[0]?.id;
      return {
        target, model: chosenModel, reasoning: chosenReasoning, ...pool.value(),
        runInWorktree: worktree.input.checked, preserveFiles: preserve.input.checked, bypassGuardian: bypass.input.checked,
        markForReview: markForReview.input.checked, hideFromHistory: hideFromHistory.input.checked, pauseOnFailure: pauseOnFailure.input.checked,
        autoRespond: readAutoReply(),
      };
    },
    onShow: syncKind,
    /** Resolves when the machine's pools and profiles are in, so a save pressed right after a machine change sees them. */
    onNode() {
      renderMachine();
      fillHarnesses(harness.value, model.value, reasoning.value);
      conversationsKey = "";
      syncKind();
      const refreshed = [pool.refresh(ctx.state.item)];
      if (autoReady) {
        fillAutoReplyModels({ ...selectedModel(arModel), thinkingLevel: arThinking.value });
        refreshed.push(arProfile.refresh(ctx.state.item?.autoRespond?.providerProfileId ?? null));
      }
      return Promise.all(refreshed);
    },
  };
}
