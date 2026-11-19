/**
 * Stands in for the TypeSafe key on a machine that has none: a request carrying it is sent to a relay
 * that lends its decision model, which swaps in its own key (decision-relay-proxy.ts). It is not a secret.
 */
export const RELAY_DECISION_KEY = "relayed-through-system-ai";

/** The fetch every System One request uses: a request with the stand-in key goes through the relay, any other goes straight out. */
export const systemOneFetch: typeof fetch = async (input, init) => {
  if (new Headers(init?.headers).get("authorization") !== `Bearer ${RELAY_DECISION_KEY}`) return fetch(input, init);
  return (await import("../decision-relay-proxy.js")).fetchThroughDecisionRelay(init!);
};
