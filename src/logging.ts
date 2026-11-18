import { installLogMasking } from "../scripts/log-masking.mjs";

/** Mandatory service logging boundary, independent of Guardian policy. */
export function installServiceLogging(): void {
  installLogMasking();
}
