import { getSubscriptionPool } from "../provider-profiles/pools.js";
import { accessibleProviderProfile } from "../provider-profiles/store.js";
import { withAutomationProfile, withoutAutomationProfile } from "../provider-profiles/context.js";

export interface AutomationAssignment { creatorAccountId?: string | null; providerProfileId?: string | null; providerPoolId?: string | null }

export function validateAutomationAssignment(input: AutomationAssignment): void {
  if (input.providerProfileId && input.providerPoolId) throw new Error("Select either a pool or a profile, not both");
  if (!input.providerProfileId && !input.providerPoolId) return;
  if (!input.creatorAccountId) throw new Error("Automation assignment requires a creator account");
  if (input.providerPoolId) getSubscriptionPool(input.creatorAccountId, input.providerPoolId);
  if (input.providerProfileId) accessibleProviderProfile(input.creatorAccountId, input.providerProfileId, "automation");
}

export function automationProfileContext(input: AutomationAssignment) {
  validateAutomationAssignment(input);
  if (!input.creatorAccountId) {
    return undefined;
  }
  return { accountId: input.creatorAccountId, profileId: input.providerProfileId ?? null, ...(input.providerPoolId ? { poolId: input.providerPoolId } : {}) };
}
/** Legacy unassigned jobs retain node defaults. Explicit assignments fail closed. */
export function runWithAutomationProfile<T>(input: AutomationAssignment, work: () => T): T {
  const context = automationProfileContext(input);
  if (!context) return withoutAutomationProfile(work);
  if (context.profileId) accessibleProviderProfile(context.accountId, context.profileId, "automation");
  return withAutomationProfile(context, work);
}
