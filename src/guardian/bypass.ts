/** The newest dispatched turn owns the exemption, even while an older turn drains background work. */
const turns = new Map<string, { bypass: boolean }>();
const key = (projectId: string, conversationId: string) => JSON.stringify([projectId, conversationId]);

export function guardianBypassed(projectId: string, conversationId: string): boolean {
  return turns.get(key(projectId, conversationId))?.bypass === true;
}

export async function withGuardianBypass<T>(projectId: string, conversationId: string, bypass: boolean, work: () => Promise<T>): Promise<T> {
  const id = key(projectId, conversationId);
  const turn = { bypass };
  turns.set(id, turn);
  try { return await work(); }
  finally { if (turns.get(id) === turn) turns.delete(id); }
}
