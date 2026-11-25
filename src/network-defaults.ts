import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

/**
 * Minimum per-address timeout for Node's Happy Eyeballs (autoSelectFamily) connects.
 * Node's default (250 ms on Node 22, 500 ms on Node 24+) aborts dual-stack TCP handshakes
 * to high-RTT hosts such as api.z.ai before the IPv4 SYN-ACK returns, failing with
 * AggregateError (ETIMEDOUT) when IPv6 is unreachable.
 */
export const MIN_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 3_000;

export function configureNetworkDefaults(): void {
  if (getDefaultAutoSelectFamilyAttemptTimeout() < MIN_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS) {
    setDefaultAutoSelectFamilyAttemptTimeout(MIN_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
  }
}
