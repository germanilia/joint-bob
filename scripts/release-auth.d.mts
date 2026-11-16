export const PUBLIC_RELEASE_API: string;
export const PUBLIC_RELEASE_WEB: string;
export function releaseApiBase(): string;
export function isGithubReleaseApi(base: string): boolean;
export function saveReleaseToken(dataDirectory: string, token: string): void;
export function fetchReleaseResource(url: string, dataDirectory: string, accept: string, timeoutMs: number): Promise<Response>;
