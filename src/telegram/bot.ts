import { Telegraf, Context } from 'telegraf';
import { WhatsAppManager } from '../whatsapp/manager';
import { MessageMatch } from '../whatsapp/message-handler';
import { config } from '../config';
import pino from 'pino';
import QRCode from 'qrcode';

const logger = pino({ name: 'telegram-bot' });

const authorizedGroupId = config.telegram.groupId;

export function createTelegramBot(manager: WhatsAppManager): Telegraf {
  const bot = new Telegraf(config.telegram.botToken);

  bot.use(groupOnlyMiddleware());

  bot.command('start', (ctx) => ctx.reply('WhatsApp Bot Controller\nUse /help for commands'));
  
  bot.command('help', (ctx) => ctx.reply(
    'Available commands:\n' +
    '/qr work|personal - Get QR code for account\n' +
    '/status - Show status of both accounts\n' +
    '/disconnect work|personal|both - Disconnect account(s)\n' +
    '/help - Show this message'
  ));

  bot.command('qr', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const account = args[0] as 'work' | 'personal' | undefined;
    
    if (!account || !['work', 'personal'].includes(account)) {
      await ctx.reply('Usage: /qr work|personal');
      return;
    }

    await ctx.reply(`Generating QR for ${account} account...`);
    manager.requestQR(account);
  });

  bot.command('status', (ctx) => {
    const status = manager.getAllStatus();
    let msg = '📱 WhatsApp Accounts Status:\n\n';
    
    for (const [name, s] of Object.entries(status)) {
      const emoji = s.connected ? '✅' : '❌';
      const session = s.hasSession ? '💾' : '🆕';
      msg += `${emoji} ${name} ${session}\n`;
      msg += `   Connected: ${s.connected ? 'Yes' : 'No'}\n`;
      if (s.user) msg += `   User: ${s.user}\n`;
      msg += '\n';
    }
    
    ctx.reply(msg);
  });

  bot.command('disconnect', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const account = args[0] as 'work' | 'personal' | 'both' | undefined;
    
    if (!account || !['work', 'personal', 'both'].includes(account)) {
      await ctx.reply('Usage: /disconnect work|personal|both');
      return;
    }

    await ctx.reply(`Disconnecting ${account} account(s)...`);
    await manager.disconnect(account);
    await ctx.reply(`Disconnected ${account} account(s). Sessions cleared.`);
  });

  manager.on('qr', async (account: 'work' | 'personal', qr: string) => {
    try {
      const qrImage = await QRCode.toBuffer(qr, { width: 300, margin: 2 });
      await bot.telegram.sendPhoto(authorizedGroupId, { source: qrImage }, { 
        caption: `QR Code for ${account} account\nScan with WhatsApp > Linked Devices` 
      });
    } catch (e) {
      logger.error({ account, error: e }, 'Failed to send QR');
      await bot.telegram.sendMessage(authorizedGroupId, `QR generated for ${account} but failed to send image.`);
    }
  });

  manager.on('connected', async (account: 'work' | 'personal') => {
    await bot.telegram.sendMessage(authorizedGroupId, `✅ ${account} account connected`);
  });

  manager.on('disconnected', async (account: 'work' | 'personal', reason: string) => {
    const reasonText = reason === 'user_requested' ? 'by user' : 
                       reason === 'logged_out' ? 'logged out' : 
                       reason === 'replaced' ? 'session replaced' : reason;
    await bot.telegram.sendMessage(authorizedGroupId, `❌ ${account} account disconnected (${reasonText})`);
  });

  manager.on('message-match', async (match: MessageMatch) => {
    const accountLabel = match.account === 'work' ? '💼 Work' : '🏠 Personal';
    const msg = `${accountLabel} account replied in group ${match.groupJid}\n` +
                `Keyword: "${match.keyword}"\n` +
                `Response: "${match.response}"`;
    await bot.telegram.sendMessage(authorizedGroupId, msg);
  });

  manager.on('error', async (account: 'work' | 'personal', error: Error) => {
    await bot.telegram.sendMessage(authorizedGroupId, `⚠️ ${account} account error: ${error.message}`);
  });

  bot.catch((err, ctx) => {
    logger.error({ err, update: ctx.update }, 'Telegram bot error');
  });

  return bot;
}

function groupOnlyMiddleware() {
  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== authorizedGroupId) {
      return;
    }
    return next();
  };
}

export function startTelegramNotifications(_bot: Telegraf, _manager: WhatsAppManager): void {
  // Already set up in createTelegramBot
}