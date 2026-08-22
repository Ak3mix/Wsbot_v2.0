import { Telegraf, Context } from 'telegraf';
import { WhatsAppManager } from '../whatsapp/manager';
import { MessageMatch } from '../whatsapp/message-handler';
import { config } from '../config';
import { logger as baseLogger, getLogs, formatLog } from '../utils/logger';
import QRCode from 'qrcode';

const logger = baseLogger.child({ name: 'telegram-bot' });

const authorizedGroupId = config.telegram.groupId;

export function createTelegramBot(manager: WhatsAppManager): Telegraf {
  const bot = new Telegraf(config.telegram.botToken);

  bot.use(groupOnlyMiddleware());

  bot.command('start', (ctx) => ctx.reply(
    '🤖 *WhatsApp Bot Controller*\n\n' +
    'Controla 2 cuentas de WhatsApp (work / personal) desde este grupo.\n' +
    'Usa /help para ver comandos.',
    { parse_mode: 'Markdown' }
  ));
  
  bot.command('help', (ctx) => ctx.reply(
    '🤖 *WhatsApp Bot - Ayuda*\n\n' +
    '*Descripción:* Bot con 2 sockets Baileys (work y personal). Auto-responde en grupos autorizados cuando detecta keywords.\n\n' +
    '*Flujo QR:*\n' +
    '1. Verifica estado: /status\n' +
    '2. Si no hay sesión (🆕), pide QR: /qr work o /qr personal\n' +
    '3. Escanea el QR en < 40s (WhatsApp > Dispositivos vinculados)\n' +
    '4. Si ya tiene sesión (💾), primero /disconnect work\n\n' +
    '*Comandos:*\n' +
    '/qr work|personal - Genera QR on-demand (solo sin sesión)\n' +
    '/status - Estado de ambas cuentas\n' +
    '/disconnect work|personal|both - Desconecta y borra sesión\n' +
    '/ping - Health check\n' +
    '/uptime - Tiempo activo y memoria\n' +
    '/logs [work|personal] [n] - Últimos N logs (default 10, max 50)\n' +
    '/help - Esta ayuda\n\n' +
    '*Auto-reply:* Grupo autorizado + usuario autorizado + keyword (aeropuerto, terminal 1/2/3) → respuesta aleatoria en WhatsApp + notificación aquí.',
    { parse_mode: 'Markdown' }
  ));

  bot.command('ping', (ctx) => ctx.reply(`pong 🏓 ${new Date().toISOString()}`));

  bot.command('uptime', (ctx) => {
    const up = process.uptime();
    const d = Math.floor(up / 86400);
    const h = Math.floor((up % 86400) / 3600);
    const m = Math.floor((up % 3600) / 60);
    const s = Math.floor(up % 60);
    const mem = process.memoryUsage();
    const rss = (mem.rss / 1024 / 1024).toFixed(1);
    const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
    ctx.reply(`⏱ Uptime: ${d}d ${h}h ${m}m ${s}s\n💾 RSS: ${rss} MB | Heap: ${heap} MB`);
  });

  bot.command('logs', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    let account: 'work' | 'personal' | undefined;
    let n = 10;
    for (const a of args) {
      if (a === 'work' || a === 'personal') account = a;
      else if (!isNaN(parseInt(a, 10))) n = Math.min(50, Math.max(1, parseInt(a, 10)));
    }
    const logs = getLogs(account, n);
    if (logs.length === 0) {
      ctx.reply('No hay logs aún.');
      return;
    }
    const text = logs.map(formatLog).join('\n');
    // Telegram limit 4096 chars; truncate if needed
    ctx.reply('```\n' + text.slice(-3800) + '\n```', { parse_mode: 'Markdown' });
  });

  bot.command('qr', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const account = args[0] as 'work' | 'personal' | undefined;
    
    if (!account || !['work', 'personal'].includes(account)) {
      await ctx.reply('Uso: /qr work|personal');
      return;
    }

    const result = await manager.requestQR(account);
    if (!result.ok) {
      if (result.reason === 'already_connected') {
        await ctx.reply(`⚠️ ${account} ya está conectado. Usa /disconnect ${account} primero si quieres reconectar.`);
        return;
      }
      if (result.reason === 'has_session') {
        await ctx.reply(`⚠️ ${account} ya tiene sesión guardada. Usa /disconnect ${account} para borrarla y luego /qr ${account}.`);
        return;
      }
      await ctx.reply(`⚠️ No se pudo generar QR para ${account}: ${result.reason}`);
      return;
    }
    await ctx.reply(`⏳ Generando QR para ${account}... (expira en 40s)`);
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
      await ctx.reply('Uso: /disconnect work|personal|both');
      return;
    }

    await ctx.reply(`Desconectando ${account}...`);
    await manager.disconnect(account);
    await ctx.reply(`Desconectado ${account}. Sesión borrada.`);
  });

  manager.on('qr', async (account: 'work' | 'personal', qr: string) => {
    try {
      const qrImage = await QRCode.toBuffer(qr, { width: 300, margin: 2 });
      await bot.telegram.sendPhoto(authorizedGroupId, { source: qrImage }, { 
        caption: `QR Code para ${account}\nEscanea en WhatsApp > Dispositivos vinculados (40s)` 
      });
    } catch (e) {
      logger.error({ account, error: e }, 'Failed to send QR');
      await bot.telegram.sendMessage(authorizedGroupId, `QR generado para ${account} pero falló el envío de imagen.`);
    }
  });

  const lastDisconnectNotify = new Map<string, number>();
  const lastConnectedNotify = new Map<string, number>();
  manager.on('connected', async (account: 'work' | 'personal') => {
    const now = Date.now();
    const last = lastConnectedNotify.get(account) ?? 0;
    if (now - last < 30000) return; // cooldown 30s
    lastConnectedNotify.set(account, now);
    await bot.telegram.sendMessage(authorizedGroupId, `✅ ${account} conectado`);
  });

  manager.on('disconnected', async (account: 'work' | 'personal', reason: string) => {
    const key = `${account}:${reason}`;
    const now = Date.now();
    const last = lastDisconnectNotify.get(key) ?? 0;
    if (now - last < 60000) return; // cooldown 60s por razón
    lastDisconnectNotify.set(key, now);
    const reasonText = reason === 'user_requested' ? 'por usuario' : 
                       reason === 'logged_out' ? 'sesión cerrada' : 
                       reason === 'replaced' ? 'sesión reemplazada' : reason;
    await bot.telegram.sendMessage(authorizedGroupId, `❌ ${account} desconectado (${reasonText})`);
  });

  manager.on('message-match', async (match: MessageMatch) => {
    const accountLabel = match.account === 'work' ? '💼 Work' : '🏠 Personal';
    const groupName = manager.getGroupName(match.account, match.groupJid);
    const msg = `${accountLabel} respondió en "${groupName}"\n` +
                `Keyword: "${match.keyword}"\n` +
                `Respuesta: "${match.response}"`;
    await bot.telegram.sendMessage(authorizedGroupId, msg);
  });

  manager.on('error', async (account: 'work' | 'personal', error: Error) => {
    await bot.telegram.sendMessage(authorizedGroupId, `⚠️ ${account} error: ${error.message}`);
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
