import { WASocket, proto, jidDecode } from '@whiskeysockets/baileys';
import { CompiledAccountConfig, CompiledKeywordRule } from '../config/types';
import { logger as baseLogger } from '../utils/logger';

const logger = baseLogger.child({ name: 'msg-handler' });

// Trazabilidad activable/desactivable vía env (MSG_LOGS=off para silenciar)
const TRACE_ENABLED = !['off', 'false', '0'].includes((process.env.MSG_LOGS ?? 'on').toLowerCase());

// Cache global LID -> teléfono (aprendido de participantPn)
const lidToPhone = new Map<string, string>();
const LID_CACHE_MAX = 2000;

interface JidInfo { user: string; server: string }

function decodeJid(jid?: string | null): JidInfo | null {
  if (!jid) return null;
  try {
    const d = jidDecode(jid);
    if (d?.user) return { user: d.user.split(':')[0], server: d.server };
  } catch {}
  const [u, s] = jid.split('@');
  return { user: (u ?? '').split(':')[0], server: s ?? '' };
}

function preview(text: string, n = 40): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export interface MessageMatch {
  account: 'work' | 'personal';
  groupJid: string;
  senderJid: string;
  keyword: string;
  response: string;
}

export function createMessageHandler(
  accountConfig: CompiledAccountConfig,
  socket: WASocket,
  onMatch: (match: MessageMatch) => void,
  getGroupName?: (jid: string) => string
): (msg: proto.IWebMessageInfo) => Promise<void> {
  const { authorizedUsers, authorizedGroups, keywordRules } = accountConfig;
  const acc = accountConfig.name;

  const handler = async (msg: proto.IWebMessageInfo): Promise<void> => {
    const receivedAt = Date.now();
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const groupJid = msg.key.remoteJid;
    // Solo grupos; DMs, status@broadcast y otros se ignoran silenciosamente
    if (!groupJid || !groupJid.endsWith('@g.us')) return;

    // --- Resolver remitente: priorizar PN (teléfono real) sobre LID ---
    // participantPn/senderPn existen en runtime pero no están tipados en Baileys 6.x
    const key = msg.key as proto.IMessageKey & { participantPn?: string; senderPn?: string };
    const part = decodeJid(msg.key.participant);
    const pn = decodeJid(key.participantPn ?? key.senderPn);

    let senderPhone: string | null = null;
    let lidNote: string | null = null;

    if (pn?.user) {
      senderPhone = pn.user;
      if (part && part.server === 'lid' && part.user !== pn.user) {
        if (lidToPhone.size >= LID_CACHE_MAX) {
          const oldest = lidToPhone.keys().next().value;
          if (oldest !== undefined) lidToPhone.delete(oldest);
        }
        lidToPhone.set(part.user, pn.user);
        lidNote = part.user;
      }
    } else if (part) {
      if (part.server === 'lid') {
        senderPhone = lidToPhone.get(part.user) ?? null;
        lidNote = part.user;
      } else {
        senderPhone = part.user;
      }
    }

    // --- Log de llegada ---
    const text0 = extractText(msg.message);
    if (TRACE_ENABLED) {
      const gName = getGroupName?.(groupJid);
      const chatLabel = gName && gName !== groupJid ? `"${gName}" (${groupJid})` : groupJid;
      const deLabel = lidNote
        ? `${senderPhone ?? 'sin-resolver'} (lid:${lidNote})`
        : (senderPhone ?? part?.user ?? '?');
      logger.info(
        { account: acc, chat: groupJid },
        `📨 IN | chat=${chatLabel} | de=${deLabel} | "${preview(text0 ?? '')}"`
      );
    }

    // --- Verificación de condiciones ---
    const cleanGroup = groupJid.replace(/@g\.us$/, '');
    const groupOk = authorizedGroups.has(groupJid) || authorizedGroups.has(cleanGroup);
    const userOk = !!senderPhone && authorizedUsers.has(senderPhone);

    if (!groupOk) {
      if (TRACE_ENABLED) logger.info({ account: acc, chat: groupJid }, '🔍 checks | grupo ❌ (chat no autorizado)');
      return;
    }
    if (!userOk) {
      if (TRACE_ENABLED) {
        const detail = lidNote && !senderPhone
          ? `lid:${lidNote} sin resolver → no autorizado`
          : `${senderPhone ?? 'desconocido'} no autorizado`;
        logger.info({ account: acc, chat: groupJid }, `🔍 checks | grupo ✅ | usuario ❌ (${detail})`);
      }
      return;
    }

    const text = text0;
    if (!text) {
      if (TRACE_ENABLED) logger.info({ account: acc, chat: groupJid }, '🔍 checks | grupo ✅ | usuario ✅ | texto ➖ (sin texto extraíble)');
      return;
    }

    // --- Keywords ---
    let matchedRule: CompiledKeywordRule | null = null;
    let matched: RegExpExecArray | null = null;
    for (const rule of keywordRules) {
      const mm = rule.regex.exec(text);
      if (mm) { matchedRule = rule; matched = mm; break; }
    }

    if (!matchedRule || !matched) {
      if (TRACE_ENABLED) logger.info({ account: acc, chat: groupJid }, `🔍 checks | grupo ✅ | usuario ✅ | keyword ➖ sin match | "${preview(text)}"`);
      return;
    }

    if (TRACE_ENABLED) logger.info({ account: acc, chat: groupJid }, `🔍 checks | grupo ✅ | usuario ✅ | keyword ✅ ("${matched[0]}")`);

    const response = pickResponse(matchedRule.responses);

    // --- Envío con fallback ---
    let sentOk = false;
    try {
      await socket.sendMessage(groupJid, { text: response }, { quoted: msg as any });
      sentOk = true;
    } catch (e1) {
      logger.warn(
        { account: acc, chat: groupJid, error: e1 instanceof Error ? e1.message : String(e1) },
        '⚠️ send con quote falló, reintentando sin quote'
      );
      try {
        await socket.sendMessage(groupJid, { text: response });
        sentOk = true;
      } catch (e2) {
        logger.error(
          { account: acc, chat: groupJid, error: e2 instanceof Error ? e2.message : String(e2) },
          '❌ send también falló sin quote'
        );
      }
    }

    logger[sentOk ? 'info' : 'warn'](
      { account: acc, chat: groupJid, sendMs: Date.now() - receivedAt },
      `${sentOk ? '💬 MATCH' : '💬 MATCH (envío falló)'} | de=${senderPhone} | kw="${matched[0]}" | resp="${response}" | ${Date.now() - receivedAt}ms`
    );

    onMatch({
      account: acc,
      groupJid,
      senderJid: msg.key.participant ?? groupJid,
      keyword: matched[0],
      response,
    });
  };

  return handler;
}

function pickResponse(responses: string[]): string {
  return responses[Math.floor(Math.random() * responses.length)] ?? '';
}

function extractText(message: proto.IMessage): string | null {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return null;
}
