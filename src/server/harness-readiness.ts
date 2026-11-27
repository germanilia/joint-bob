import { getHarnessRuntime, listHarnesses } from "../harnesses.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getClusterNode } from "../cluster.js";
import { clusterPoolServesEngine } from "../provider-profiles/pool-sharing.js";
import type { HarnessId } from "../types.js";
import { measureOperation } from "./performance-diagnostics.js";

/** Shared by new-conversation and automation selection on the execution machine. */
export async function harnessProblems(id: HarnessId, cwd = process.cwd()): Promise<string[]> {
  if (!listHarnesses().some(harness => harness.id === id && harness.runtime)) return ["No runtime on this node"];
  const runtime = await getHarnessRuntime(id);
  const installation = await measureOperation(`harness.readiness.${id}`, () => runtime.readiness(cwd));
  if (installation.length) return installation;
  const signIn = await measureOperation(`harness.sign_in.${id}`, () => runtime.signInProblems());
  if (signIn.length && clusterPoolServesEngine(await clusterV2Database(), (await getClusterNode()).id, id)) return [];
  return signIn;
}
