import type { Transform } from "node:stream";
export function registerLogSecrets(secrets: string[]): void;
export function logSecretValues(): string[];
export function registerEnvironmentLogSecrets(env: NodeJS.ProcessEnv): void;
export function maskLogText(text: string): string;
export function createLogMasker(): { write(chunk: string | Buffer): string; end(): string };
export function createLogMaskingStream(): Transform;
export function installLogMasking(env?: NodeJS.ProcessEnv): void;
