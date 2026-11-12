import type { ChatMessage } from "../types.js";
import { PUSH_PREFIX } from "./review-check.js";

/** What a needs-you card shows when it is opened: the ask, the agent's last words and the last few steps, without opening the conversation. */
export interface CardDetail {
  /** What the person last asked for; Bob's own pushes are passed over. */
  request: string;
  /** The agent's last message, whole up to the limit. */
  answer: string;
  answerAt: string | null;
  /** The answer was longer than the limit and its start was cut. */
  answerCut: boolean;
  /** The last tool steps the agent took, oldest first. */
  steps: Array<{ name: string; target: string; failed: boolean }>;
  /** The conversation's transcript could not be read on this machine. */
  unavailable?: boolean;
}

export const ANSWER_LIMIT = 24_000;
const REQUEST_LIMIT = 4_000;
const STEPS = 5;

/** Reads the detail out of a transcript. The end of a long answer matters most, so its start is cut first. */
export function cardDetail(messages: ReadonlyArray<ChatMessage>): CardDetail {
  const asked = messages.filter((message) => message.role === "user" && message.text?.trim());
  const request = ([...asked].reverse().find((message) => !message.text.startsWith(PUSH_PREFIX)) ?? asked.at(-1))?.text.trim() ?? "";
  const answered = [...messages].reverse().find((message) => message.role === "assistant" && message.text?.trim());
  const text = answered?.text.trim() ?? "";
  const steps = messages
    .filter((message) => message.role === "tool" || message.role === "toolResult")
    .filter((message) => message.toolName)
    .slice(-STEPS)
    .map((message) => ({ name: message.toolName!, target: message.toolTarget?.target ?? message.toolTarget?.skill ?? "", failed: Boolean(message.isError) }));
  return {
    request: request.slice(0, REQUEST_LIMIT),
    answer: text.length > ANSWER_LIMIT ? text.slice(-ANSWER_LIMIT) : text,
    answerAt: answered?.timestamp ?? null,
    answerCut: text.length > ANSWER_LIMIT,
    steps,
  };
}
