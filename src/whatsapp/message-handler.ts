import { WASocket, proto, jidDecode } from '@whiskeysockets/baileys';
import { CompiledAccountConfig } from '../config/types';

export interface MessageMatch {
  account: 'work' | 'personal';
  groupJid: string;
  senderJid: string;
  keyword: string;
  response: string;
}

function extractPhone(jid: string): string {
  try {
    const decoded = jidDecode(jid);
    if (decoded?.user) return decoded.user.split(':')[0];
  } catch {}
  return jid.split('@')[0].split(':')[0];
}

export function createMessageHandler(
  accountConfig: CompiledAccountConfig,
  socket: WASocket,
  onMatch: (match: MessageMatch) => void
): (msg: proto.IWebMessageInfo) => void {
  const { authorizedUsers, authorizedGroups, keywordRules } = accountConfig;

  const handler = async (msg: proto.IWebMessageInfo): Promise<void> => {
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const senderJid = msg.key.participant ?? msg.key.remoteJid;
    const groupJid = msg.key.remoteJid;

    if (!senderJid || !groupJid) return;

    const senderPhone = extractPhone(senderJid);
    
    // Validar usuario autorizado (sin prefijo/sufijo de dispositivo)
    if (!authorizedUsers.has(senderPhone)) return;

    // Validar grupo autorizado (soporta si guardas con o sin @g.us)
    const cleanGroup = groupJid.replace('@g.us', '');
    const isAuthorizedGroup = authorizedGroups.has(groupJid) || authorizedGroups.has(cleanGroup);
    if (!isAuthorizedGroup) return;

    const text = extractText(msg.message);
    if (!text) return;

    for (const rule of keywordRules) {
      const regexMatch = rule.regex.exec(text);
      if (regexMatch) {
        const response = rule.responses[Math.floor(Math.random() * rule.responses.length)];
        
        try {
          await socket.sendMessage(groupJid, { text: response }, { quoted: msg as any });
        } catch (sendError) {
          console.error('Failed to send auto-reply (with quote):', sendError);
          // Fallback: send without quoted
          try {
            await socket.sendMessage(groupJid, { text: response });
          } catch (secondError) {
            console.error('Failed to send auto-reply (no quote):', secondError);
          }
        }
        
        onMatch({
          account: accountConfig.name,
          groupJid,
          senderJid,
          keyword: regexMatch[0],
          response,
        });
        break;
      }
    }
  };

  return handler;
}

function extractText(message: proto.IMessage): string | null {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return null;
}