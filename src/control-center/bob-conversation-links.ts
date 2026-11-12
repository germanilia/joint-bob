import type { BobAction } from "./bob-store.js";

export interface BobConversationLink {
  projectId: string;
  conversationId: string;
  title: string;
}

/** Only server-supplied, accessible conversations can become navigation actions. */
export function bobConversationLinks(answer: string, conversations: BobConversationLink[]): { text: string; actions: BobAction[] } {
  const actions: BobAction[] = [];
  const used = new Set<number>();
  const text = answer.replace(/\[\[conversation:(\d+)\]\]/g, (_, value: string) => {
    const index = Number(value);
    const conversation = conversations[index];
    if (!conversation) return "";
    if (!used.has(index) && actions.length < 12) {
      used.add(index);
      actions.push({ id: "open", label: `Open: ${conversation.title}`, data: { open: conversation } });
    }
    return conversation.title;
  });
  return { text: text.trim(), actions };
}
