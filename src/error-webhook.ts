import { registerLogSecrets } from "../scripts/log-masking.mjs";
import { z } from "zod";
import { save, settingsDatabase, value } from "./settings-store.js";

const KEY = "errorWebhook";
const INLINE_LIMIT = 3_800;
const ATTACHMENT_LIMIT = 128_000;
const URL_ERROR = "Enter an HTTPS webhook URL without a username, password, or fragment";
const updateSchema = z.object({ enabled: z.boolean(), url: z.string().trim().max(4096).optional() }).strict();

export class ErrorWebhookSettingsError extends Error {}

let defaultUrl: URL | null = null;

/** Read once at startup. Agent and shell subprocesses must not inherit a capability URL. */
export function loadErrorWebhookDefault(): void {
  const raw = process.env.JOINT_BOB_ERROR_WEBHOOK_URL?.trim();
  delete process.env.JOINT_BOB_ERROR_WEBHOOK_URL;
  defaultUrl = raw ? parseUrl(raw) : null;
  if (raw) registerLogSecrets([raw, ...(defaultUrl ? [defaultUrl.href] : [])]);
  if (raw && !defaultUrl) console.warn(`Invalid JOINT_BOB_ERROR_WEBHOOK_URL: ${URL_ERROR}`);
}

function parseUrl(value: string): URL | null {
  const url = URL.parse(value);
  return url?.protocol === "https:" && !url.username && !url.password && !url.hash ? url : null;
}

function config() {
  const stored: { enabled: boolean; url: string } = JSON.parse(value(KEY, '{"enabled":false,"url":""}'));
  const url = stored.url ? parseUrl(stored.url) : defaultUrl;
  if (url) registerLogSecrets([url.href]);
  return { stored, url };
}

/** Show the destination origin, never the capability URL, including to the admin. */
export function errorWebhookSettings() {
  const { stored, url } = config();
  return { enabled: stored.enabled && Boolean(url), destination: url ? stored.url ? "custom" : "default" : null, origin: url?.origin ?? null };
}

export function updateErrorWebhookSettings(input: unknown) {
  const next = updateSchema.safeParse(input);
  if (!next.success) throw new ErrorWebhookSettingsError("Invalid error webhook settings");
  const { stored } = config();
  const { enabled, url = stored.url } = next.data;
  if (url && !parseUrl(url)) throw new ErrorWebhookSettingsError(URL_ERROR);
  if (enabled && !url && !defaultUrl) {
    throw new ErrorWebhookSettingsError("Enter a webhook URL before enabling delivery");
  }
  save(settingsDatabase(), KEY, JSON.stringify({ enabled, url }), true);
  return errorWebhookSettings();
}

export function errorWebhookDestination(): URL | null {
  const { stored, url } = config();
  return stored.enabled ? url : null;
}

export interface ErrorWebhookPayload {
  channel: "client" | "backend";
  reportedAt: string;
  node: string;
  version: string;
  summary: string;
  source?: string;
  withheld: number;
  detail?: string;
}

export async function deliverErrorWebhook(url: URL, payload: ErrorWebhookPayload): Promise<void> {
  const { summary, detail = "", ...metadata } = payload;
  let body: string | FormData;
  const headers: Record<string, string> = {};
  if (summary.length + detail.length <= INLINE_LIMIT) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  } else {
    body = new FormData();
    for (const [key, value] of Object.entries(metadata)) body.set(key, String(value));
    body.set("summary", summary.slice(0, INLINE_LIMIT));
    const text = [summary, detail].filter(Boolean).join("\n\n");
    const bounded = text.length > ATTACHMENT_LIMIT ? `${text.slice(0, ATTACHMENT_LIMIT)}\n… truncated` : text;
    body.set("attachment", new Blob([bounded], { type: "text/plain" }), "joint-bob-error.txt");
  }
  const response = await fetch(url, { method: "POST", body, headers, redirect: "error", signal: AbortSignal.timeout(8_000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
