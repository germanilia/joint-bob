import assert from "node:assert/strict";
import test from "node:test";
import { actingAccount, asNode } from "../src/account-context.js";
import { JOINT_BOB_TOOL_SERVER } from "../src/assistant-collaboration/bridge-tools.js";
import { getClusterNode } from "../src/cluster.js";
import { managedMcpBridgeConfigs, mcpAgentEnvironment } from "../src/mcp/agent.js";
import { automationProfileContext } from "../src/provider-profiles/context.js";
import { withPromptProfile } from "../src/server/harness-chat.js";

test("withPromptProfile restores acting account for automation and team turns so managed and joint_bob MCP attach", async () => {
  const local = await getClusterNode();
  const ownerId = `automation-owner-${Date.now()}`;
  const connection = { project: { id: "proj-1", name: "Test", path: "/tmp" } as never, author: undefined };
  const prompt = {
    author: undefined,
    automationProfile: { nodeId: local.id, accountId: ownerId, profileId: null },
  };

  const result = await asNode(() => withPromptProfile(connection, prompt, async () => {
    const actor = actingAccount();
    const automation = automationProfileContext();
    const bridges = managedMcpBridgeConfigs();
    const mcpEnv = mcpAgentEnvironment("proj-1", "antigravity", "conv-1");
    return {
      accountId: actor?.accountId,
      automationAccountId: automation?.accountId,
      hasJointBob: Object.hasOwn(bridges, JOINT_BOB_TOOL_SERVER),
      hasMcpApi: Boolean(mcpEnv.JOINT_BOB_MCP_API),
      hasMcpToken: Boolean(mcpEnv.JOINT_BOB_MCP_TOKEN),
    };
  }));

  assert.deepEqual(result, {
    accountId: ownerId,
    automationAccountId: ownerId,
    hasJointBob: true,
    hasMcpApi: true,
    hasMcpToken: true,
  });
});
