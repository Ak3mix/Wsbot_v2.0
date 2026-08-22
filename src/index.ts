import { WhatsAppManager } from './whatsapp/manager';
import { createTelegramBot } from './telegram/bot';
import { createHttpServer } from './server/http';
import { config, compiledConfig } from './config';
import pino from 'pino';

const logger = pino({ name: 'main' });

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

  telegramBot.launch().then(() => {
    logger.info('Telegram bot started');
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