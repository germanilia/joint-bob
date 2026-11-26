import { z } from "zod";
import type { ProposedRule } from "./conversation-digest.js";

export const closeoutFeedbackSchema = z.object({
  rating: z.enum(["good", "bad", "unimportant"]),
  description: z.string().trim().max(1000).default(""),
}).strict();
export type CloseoutFeedback = z.infer<typeof closeoutFeedbackSchema>;
export const closeoutRecordSchema = z.object({
  revision: z.string(), projectId: z.string(), engine: z.string(),
  source: z.enum(["manual", "automatic"]),
  feedback: closeoutFeedbackSchema.nullable(),
  status: z.enum(["pending", "complete", "error"]),
  error: z.string().optional(),
}).strict();
export type CloseoutRecord = z.infer<typeof closeoutRecordSchema>;
/** A project lesson goes to the project's knowledge; a general one to Joint Bob's, which ships with the app. */
export type LessonScope = "project" | "general";
export type LearnedRule = ProposedRule & { scope: LessonScope };
export interface CloseoutDeps {
  classify(): Promise<"good" | "bad">;
  describe(rating: "good" | "bad", description: string): Promise<{ description: string; rules: LearnedRule[] }>;
  select(rating: "good" | "bad", description: string, rules: LearnedRule[]): Promise<number[]>;
}

/** Every conversation is reviewed. A Good or Bad rating is authoritative; "not important" leaves the rating to the decision model. */
export async function closeoutAssessment(feedback: CloseoutFeedback | null, deps: CloseoutDeps): Promise<{ rating: "good" | "bad"; description: string; rules: LearnedRule[] }> {
  const rating = feedback && feedback.rating !== "unimportant" ? feedback.rating : await deps.classify();
  const draft = await deps.describe(rating, feedback?.description ?? "");
  const description = feedback?.description || draft.description;
  const selected = draft.rules.length ? await deps.select(rating, description, draft.rules) : [];
  return { rating, description, rules: draft.rules.filter((_, index) => selected.includes(index)) };
}

/** Files syncing or summaries updating are not interactions. Missing timestamps cannot prove inactivity. */
export function inactiveConversation(messages: ReadonlyArray<{ role: string; timestamp?: string }>, busy: boolean, done: boolean, now: number): boolean {
  if (busy || done) return false;
  const timestamps = messages.filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => Date.parse(message.timestamp ?? ""));
  if (!timestamps.length || timestamps.some((stamp) => !Number.isFinite(stamp))) return false;
  return now - Math.max(...timestamps) > 4 * 24 * 3_600_000;
}
