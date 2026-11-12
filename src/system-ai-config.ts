import { z } from 'zod';
import { value } from './settings-store.js';

export const systemAgentSchema = z.object({
  harnessId: z.string().trim().min(1).max(100), provider: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(300), thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
}).strict();
const profile = z.string().uuid().nullable();
export const systemAiSchema = z.object({
  decision: z.object({ model: z.enum(['typesafe', 'laya']), typesafeAccountId: profile, layaAccountId: profile }).strict(),
  operations: z.object({ feedback: systemAgentSchema.nullable(), knowledge: systemAgentSchema.nullable() }).strict(),
  quality: z.object({ modelId: z.string().trim().max(300) }).strict(),
  profiles: z.object({ claude: profile, pi: profile, kiro: profile, 'openai-codex': profile }).strict(),
  /** enabled drives the Joint Bob default routing on this machine; shareWithRelay lends the decision model to the machines of the relay this machine serves. */
  routing: z.object({ enabled: z.boolean(), shareWithRelay: z.boolean() }).strict().default({ enabled: true, shareWithRelay: false }),
}).strict();
export type SystemAiSettings = z.infer<typeof systemAiSchema>;
export type SystemOperation = keyof SystemAiSettings['operations'];
export function systemAiDefaults(): SystemAiSettings {
  return { decision: { model: 'typesafe', typesafeAccountId: null, layaAccountId: null }, operations: { feedback: null, knowledge: null },
    quality: { modelId: '' }, profiles: { claude: null, pi: null, kiro: null, 'openai-codex': null }, routing: { enabled: true, shareWithRelay: false } };
}
export function systemAiSettings(): SystemAiSettings {
  const stored = value('systemAI');
  return stored ? systemAiSchema.parse(JSON.parse(stored)) : systemAiDefaults();
}
