import type { HarnessModel, HarnessModelSettings } from "../harnesses/runtime.js";
import type { HarnessId } from "../types.js";
import type { ProfileProvider } from "./store.js";

export type PoolFailureReason = "quota" | "auth" | "unavailable" | "other";

export class PoolAttemptFailure extends Error {
  constructor(readonly reason: PoolFailureReason, readonly started: boolean, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PoolAttemptFailure";
  }
}

export function orderPoolCandidates<C extends { provider: ProfileProvider }>(
  candidates: readonly C[], preferredProvider?: ProfileProvider, sameProviderOnly = false,
): C[] {
  const eligible = sameProviderOnly && preferredProvider
    ? candidates.filter((candidate) => candidate.provider === preferredProvider)
    : [...candidates];
  if (!preferredProvider) return eligible;
  return [
    ...eligible.filter((candidate) => candidate.provider === preferredProvider),
    ...eligible.filter((candidate) => candidate.provider !== preferredProvider),
  ];
}

export interface PoolClassifierModelMapping { provider: string; modelId: string; reasoning?: string }

function profileProviderForModel(provider: string): ProfileProvider | undefined {
  if (provider === "anthropic" || provider === "claude") return "claude";
  return provider === "openai-codex" ? provider : undefined;
}

export function resolvePoolModelSettings(engine: HarnessId, candidateProvider: ProfileProvider, initial: HarnessModelSettings,
  mapping?: PoolClassifierModelMapping, fallbackModel?: string): HarnessModelSettings {
  if (candidateProvider === "pi" && engine === "pi") return initial;
  if (profileProviderForModel(initial.provider) === candidateProvider) return initial;
  if (engine !== "pi") throw new Error("This harness cannot switch providers while using a subscription pool");
  if (mapping && profileProviderForModel(mapping.provider) === candidateProvider) {
    return { ...initial, provider: candidateProvider === "claude" ? "anthropic" : candidateProvider,
      modelId: mapping.modelId, reasoning: mapping.reasoning ?? initial.reasoning };
  }
  if (!fallbackModel) throw new Error(`Configure a fallback model for ${candidateProvider} in this pool before cross-provider failover`);
  // The turn keeps its effort; promptOnSubscriptionPool moves it to the nearest one the fallback model offers.
  return { ...initial, provider: candidateProvider === "claude" ? "anthropic" : candidateProvider, modelId: fallbackModel };
}

/** A single harness choice is optional; an incompatible or removed model uses the destination's default. */
export function resolvePoolSwitchModel(candidate: ProfileProvider, initial: HarnessModelSettings, selected: string | undefined,
  models: HarnessModel[], defaults: { provider: string; modelId: string; thinkingLevel: string }): HarnessModelSettings {
  const compatible = models.filter((model) => candidate === "pi" || model.provider === candidate || candidate === "claude" && model.provider === "anthropic");
  const chosen = selected ? compatible.find((model) => selected === `${model.provider}/${model.id}` || selected === model.id) : undefined;
  const model = chosen ?? compatible.find((model) => model.provider === defaults.provider && model.id === defaults.modelId) ?? compatible[0];
  if (!model) throw new Error(`No compatible default model for ${candidate}`);
  return { ...initial, provider: model.provider, modelId: model.id, reasoning: chosen ? initial.reasoning : defaults.thinkingLevel };
}

export function classifyPoolAttemptFailure(error: unknown, started: boolean): PoolAttemptFailure | undefined {
  if (error instanceof PoolAttemptFailure) {
    return new PoolAttemptFailure(error.reason, started || error.started, error.message, { cause: error });
  }
  if (!(error instanceof Error)) return undefined;
  const details = error as Error & { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = details.status ?? details.statusCode;
  const code = typeof details.code === "string" ? details.code.toLowerCase() : "";
  const message = `${code} ${error.message}`.toLowerCase();
  // Claude reports a subscription limit as "You've hit your 5-hour limit" with the code rate_limit.
  const reason: PoolFailureReason | undefined = status === 429 || /rate[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|usage limit|hit your [\w -]*limit|too many requests|insufficient_quota|billing_error/.test(message)
    ? "quota"
    : status === 401 || status === 403 || /invalid_grant|authentication[_ -]?(?:error|failed)|unauthorized|token (?:expired|revoked)|sign[- ]in required|sign in to .* again|sign in on this node/.test(message)
      ? "auth"
      : undefined;
  return reason ? new PoolAttemptFailure(reason, started, error.message, { cause: error }) : undefined;
}

/** A failure the next pool member can take over from: quota or sign-in at any point, an unusable member before it starts. */
function handsOver(failure: PoolAttemptFailure): boolean {
  return failure.started ? failure.reason === "quota" || failure.reason === "auth" : ["quota", "auth", "unavailable"].includes(failure.reason);
}

/**
 * Runs a turn on each pool member in turn until one finishes it. A member that fails before
 * starting is rolled back to the last checkpoint and the next one gets the same prompt. A member
 * that runs out of quota or sign-in mid-turn keeps the work it did: the next member is told to
 * continue (`continuing`), so nothing already done is replayed.
 */
export async function runPoolAttempts<T, C extends { provider: ProfileProvider }>(
  candidates: readonly C[],
  preferredProvider: ProfileProvider | undefined,
  attempt: (candidate: C, continuing: boolean) => Promise<T>,
  checkpoint: () => Promise<() => Promise<void>>,
  sameProviderOnly = false,
): Promise<T> {
  const ordered = orderPoolCandidates(candidates, preferredProvider, sameProviderOnly);
  if (!ordered.length) throw new Error("No compatible subscription profile is available in this pool");
  let restore = await checkpoint();
  let continuing = false;
  for (let index = 0; index < ordered.length; index += 1) {
    try { return await attempt(ordered[index], continuing); }
    catch (error) {
      const failure = classifyPoolAttemptFailure(error, false);
      if (!failure || !handsOver(failure)) throw error;
      if (index === ordered.length - 1) throw failure;
      if (failure.started) {
        continuing = true;
        restore = await checkpoint();
      } else await restore();
    }
  }
  throw new Error("Subscription pool attempts ended unexpectedly");
}

/**
 * The models one pool member may answer with, in the order they are tried when one is rate-limited before it answers: the
 * chosen one first, then the member's other models. Only Claude limits each model on its own, so only a Claude member has more
 * than one; another provider's limit is the account's, and the next member is the way on.
 */
export function memberModelLadder(candidate: ProfileProvider, first: { provider: string; modelId: string }, models: HarnessModel[], limit = 4): string[] {
  if (candidate !== "claude") return [first.modelId];
  const others = models.filter((model) => (model.provider === "anthropic" || model.provider === "claude") && model.id !== first.modelId).map((model) => model.id);
  return [first.modelId, ...others].slice(0, limit);
}

/**
 * A limit on how fast one model may be called ("would exceed your account's rate limit"), which another model does not share.
 * A usage limit ("You've hit your 5-hour limit", an exhausted quota) is the whole subscription's: the next member takes over.
 */
function modelRateLimited(failure: PoolAttemptFailure): boolean {
  const message = failure.message.toLowerCase();
  return failure.reason === "quota" && /rate[_ -]?limit|too many requests|429/.test(message) && !/hit your [\w -]*limit|usage limit|quota|insufficient_quota|billing/.test(message);
}

/**
 * Runs one member's attempt on each model of its ladder until one answers. Only a model's rate limit before anything was said moves to
 * the next model (the state is rolled back first); anything else, or a limit on the last model, goes on as the member's failure.
 */
export async function runOnModels<T>(models: readonly string[], attempt: (modelId: string) => Promise<T>, restore: () => Promise<void>): Promise<T> {
  for (const [index, modelId] of models.entries()) {
    try { return await attempt(modelId); }
    catch (error) {
      const failure = classifyPoolAttemptFailure(error, false);
      if (!failure || !modelRateLimited(failure) || failure.started || index === models.length - 1) throw error;
      console.warn(`Pool model ${modelId} is rate-limited; trying ${models[index + 1]}`);
      await restore();
    }
  }
  throw new Error("A pool member has no model to try");
}
