import { z } from 'zod';

export const KeywordRuleSchema = z.object({
  keywords: z.array(z.string()).min(1),
  responses: z.array(z.string()).min(1),
  requireAllKeywords: z.boolean().default(false),
});

export type KeywordRule = z.infer<typeof KeywordRuleSchema>;

export const AccountConfigSchema = z.object({
  name: z.enum(['work', 'personal']),
  sessionName: z.string(),
  authorizedUsers: z.array(z.string()).default([]),
  authorizedGroups: z.array(z.string()).default([]),
  keywords: z.array(KeywordRuleSchema).default([]),
});

export type AccountConfig = z.infer<typeof AccountConfigSchema>;

export const TelegramConfigSchema = z.object({
  botToken: z.string().min(1),
  groupId: z.string().min(1),
});

export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

export const AppConfigSchema = z.object({
  port: z.number().default(10000),
  nodeEnv: z.enum(['development', 'production']).default('production'),
  telegram: TelegramConfigSchema,
  accounts: z.tuple([AccountConfigSchema, AccountConfigSchema]),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export interface CompiledKeywordRule {
  regex: RegExp;
  responses: string[];
  matchedKeyword: string;
}

export interface CompiledAccountConfig {
  name: 'work' | 'personal';
  sessionName: string;
  authorizedUsers: Set<string>;
  authorizedGroups: Set<string>;
  keywordRules: CompiledKeywordRule[];
}