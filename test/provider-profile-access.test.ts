import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAsAccount } from "../src/account-context.js";
import { addProject } from "../src/store.js";
import { setResourceOwner } from "../src/ownership.js";
import { createProviderProfile, profileInputSchema, profileSelectionSchema, setProviderProfileSelection, setProviderProfileShared } from "../src/provider-profiles/store.js";
import { projectProviderProfile } from "../src/provider-profiles/service.js";
import { createSubscriptionPool } from "../src/provider-profiles/pools.js";
import { withAutomationProfile } from "../src/provider-profiles/context.js";

const actor = (accountId: string) => ({ accountId, username: accountId, role: "member" as const, isRemoteLogin: false, homeNodeId: null });
test("Antigravity is a standalone provider profile and cannot be shared or pooled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-profile-rules-"));
  try {
    await addProject("Antigravity profile rules", root, { writeInstructions: false });
    assert.deepEqual(profileInputSchema.parse({ provider: "antigravity", label: "Google work" }), { provider: "antigravity", label: "Google work" });
    assert.throws(() => profileInputSchema.parse({ provider: "antigravity", label: "Google work", shared: true }), /Unrecognized key/);
    assert.throws(() => profileSelectionSchema.parse({ provider: "antigravity", scope: "default", scopeId: "", profileId: null, poolId: "00000000-0000-4000-8000-000000000001" }), /standalone/);
    const profile = createProviderProfile("antigravity-owner", { provider: "antigravity", label: "Google work" });
    assert.throws(() => setProviderProfileShared(profile.owner, profile.id, true), /private and standalone/);
    assert.throws(() => createSubscriptionPool(profile.owner, { name: "Google pool", profileIds: [profile.id], fallbackModels: {} }), /standalone/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("Antigravity assignments resolve the acting user's private profile and require a profile for members", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-profile-access-"));
  try {
    const project = await addProject("Antigravity user profiles", root, { writeInstructions: false });
    const owner = "antigravity-user";
    const fallback = createProviderProfile(owner, { provider: "antigravity", label: "Google default" });
    const conversation = createProviderProfile(owner, { provider: "antigravity", label: "Google personal" });
    setProviderProfileSelection(owner, { provider: "antigravity", scope: "default", scopeId: "", profileId: fallback.id });
    setProviderProfileSelection(owner, { provider: "antigravity", scope: "conversation", scopeId: JSON.stringify([project.id, "conversation"]), profileId: conversation.id });
    assert.equal((await runAsAccount(actor(owner), () => projectProviderProfile(project.id, "conversation", "antigravity", "antigravity")))?.id, conversation.id);
    assert.equal((await runAsAccount(actor(owner), () => projectProviderProfile(project.id, "other-conversation", "antigravity", "antigravity")))?.id, fallback.id);
    await assert.rejects(runAsAccount(actor("unassigned-antigravity-user"), () => projectProviderProfile(project.id, "conversation", "antigravity", "antigravity")), /Select your own subscription profile/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same project resolves the acting user's selection, never its owner's profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "user-profile-access-"));
  try {
    const project = await addProject("User profiles", root);
    setResourceOwner("project", project.id, "project-owner");
    const owner = createProviderProfile("project-owner", { label: "Owner", provider: "claude" });
    const visitor = createProviderProfile("visitor", { label: "Visitor", provider: "claude" });
    for (const profile of [owner, visitor]) setProviderProfileSelection(profile.owner, { provider: "claude", scope: "project", scopeId: project.id, profileId: profile.id });
    assert.equal((await runAsAccount(actor("project-owner"), () => projectProviderProfile(project.id, "c", "claude")))?.id, owner.id);
    assert.equal((await runAsAccount(actor("visitor"), () => projectProviderProfile(project.id, "c", "claude")))?.id, visitor.id);
    await assert.rejects(runAsAccount(actor("unassigned"), () => projectProviderProfile(project.id, "c", "claude")), /Select your own subscription profile/);
    assert.equal(await projectProviderProfile(project.id, "c", "claude"), undefined);
    const shared = createProviderProfile("team", { label: "Automation only", provider: "claude" });
    setProviderProfileShared(shared.owner, shared.id, true);
    assert.equal((await withAutomationProfile({ accountId: "visitor", profileId: shared.id }, () => projectProviderProfile(project.id, "c", "claude")))?.id, shared.id);
    assert.equal((await withAutomationProfile({ accountId: "visitor", profileId: null }, () => projectProviderProfile(project.id, "c", "claude")))?.id, visitor.id);
    await assert.rejects(withAutomationProfile({ accountId: "visitor", profileId: shared.id }, () => projectProviderProfile(project.id, "c", "openai-codex")), /does not match/);
    setProviderProfileShared(shared.owner, shared.id, false);
    await assert.rejects(withAutomationProfile({ accountId: "visitor", profileId: shared.id }, () => projectProviderProfile(project.id, "c", "claude")), /access revoked/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
