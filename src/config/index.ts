import { z } from 'zod';
import { AppConfigSchema, AppConfig, CompiledAccountConfig, CompiledKeywordRule, KeywordRuleSchema } from './types';

function parseJsonEnv<T>(key: string, schema: z.ZodSchema<T>, defaultValue: T): T {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  try {
    const parsed = JSON.parse(raw);
    return schema.parse(parsed);
  } catch (e) {
    console.error(`Failed to parse ${key}:`, e);
    return defaultValue;
  }
}

function normalizePhone(jid: string): string {
  return jid.split('@')[0];
}

function compileKeywordRules(rules: AppConfig['accounts'][0]['keywords']): CompiledKeywordRule[] {
  return rules.map(rule => {
    const escapedKeywords = rule.keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = rule.requireAllKeywords
      ? escapedKeywords.map(k => `(?=.*${k})`).join('') + '.*'
      : escapedKeywords.join('|');
    return {
      regex: new RegExp(pattern, 'i'),
      responses: rule.responses,
      matchedKeyword: rule.keywords[0],
    };
  });
}

export function loadConfig(): AppConfig {
  const telegram = {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    groupId: process.env.TELEGRAM_GROUP_ID ?? '',
  };

  const accounts = [
    {
      name: 'work' as const,
      sessionName: process.env.WORK_SESSION_NAME ?? 'work',
      authorizedUsers: parseJsonEnv('WORK_AUTH_USERS', z.array(z.string()), []),
      authorizedGroups: parseJsonEnv('WORK_AUTH_GROUPS', z.array(z.string()), []),
      keywords: parseJsonEnv('WORK_KEYWORDS', z.array(KeywordRuleSchema), []),
    },
    {
      name: 'personal' as const,
      sessionName: process.env.PERSONAL_SESSION_NAME ?? 'personal',
      authorizedUsers: parseJsonEnv('PERSONAL_AUTH_USERS', z.array(z.string()), []),
      authorizedGroups: parseJsonEnv('PERSONAL_AUTH_GROUPS', z.array(z.string()), []),
      keywords: parseJsonEnv('PERSONAL_KEYWORDS', z.array(KeywordRuleSchema), []),
    },
  ] as const;

  const config = AppConfigSchema.parse({
    port: parseInt(process.env.PORT ?? '10000', 10),
    nodeEnv: (process.env.NODE_ENV as 'development' | 'production') ?? 'production',
    telegram,
    accounts,
  });

  return config;
}

export function compileConfig(config: AppConfig): CompiledAccountConfig[] {
  return config.accounts.map(acc => ({
    name: acc.name,
    sessionName: acc.sessionName,
    authorizedUsers: new Set(acc.authorizedUsers.map(normalizePhone)),
    authorizedGroups: new Set(acc.authorizedGroups.map(normalizePhone)),
    keywordRules: compileKeywordRules(acc.keywords),
  }));
}

export const config = loadConfig();
export const compiledConfig = compileConfig(config);