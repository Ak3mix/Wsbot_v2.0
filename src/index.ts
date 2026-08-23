import { WhatsAppManager } from './whatsapp/manager';
import { createTelegramBot } from './telegram/bot';
import { createHttpServer } from './server/http';
import { config, compiledConfig } from './config';
import { logger } from './utils/logger';
import type { Telegraf } from 'telegraf';

// Render solapa instancias durante deploys: la instancia previa sigue haciendo
// getUpdates mientras la nueva arranca → 409 Conflict. Reintentamos hasta ganar.
async function launchTelegramWithRetry(bot: Telegraf): Promise<void> {
  const MAX_ATTEMPTS = 20; // ~5 min de ventana
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await bot.launch();
      logger.info('Telegram bot started');
      return;
    } catch (e: any) {
      const code: number =
        e?.response?.error_code ??
        Number(/(\d{3})/.exec(String(e?.message ?? ''))?.[1] ?? 0);
      if (code !== 409 || attempt === MAX_ATTEMPTS) throw e;
      logger.warn(
        { attempt, max: MAX_ATTEMPTS },
        '⏳ 409 conflicto (instancia previa aún viva), reintentando en 15s'
      );
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

async function main(): Promise<void> {
  logger.info('Starting WhatsApp-Telegram Bot...');
  
  if (!config.telegram.botToken || !config.telegram.groupId) {
    logger.error('Missing Telegram configuration');
    process.exit(1);
  }

  const manager = new WhatsAppManager(compiledConfig);
  const telegramBot = createTelegramBot(manager);
  createHttpServer(manager, config.port);

  manager.on('qr', (account: 'work' | 'personal', _qr: string) => {
    logger.info({ account }, 'QR code generated');
  });

  manager.on('connected', (account: 'work' | 'personal') => {
    logger.info({ account }, 'WhatsApp connected');
  });

  manager.on('disconnected', (account: 'work' | 'personal', reason: string) => {
    logger.warn({ account, reason }, 'WhatsApp disconnected');
  });

  manager.on('message-match', (match: { account: 'work' | 'personal'; keyword: string }) => {
    logger.info({ account: match.account, keyword: match.keyword }, 'Auto-reply sent');
  });

  manager.on('error', (account: 'work' | 'personal', error: Error) => {
    logger.error({ account, error: error.message }, 'WhatsApp error');
  });

  try {
    await manager.connectAll();
    logger.info('WhatsApp sockets initialized');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize WhatsApp');
  }

  launchTelegramWithRetry(telegramBot).catch((error) => {
    logger.fatal({ error }, 'Telegram bot failed to start after retries');
    process.exit(1);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    telegramBot.stop(signal);
    await manager.disconnect('both');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.fatal({ error }, 'Fatal error');
  process.exit(1);
});