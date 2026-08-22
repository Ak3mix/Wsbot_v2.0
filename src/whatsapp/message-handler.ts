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
    if (decoded?.user) return decoded.user;
  } catch {}
  return jid.split('@')[0];
}

export function createMessageHandler(
  accountConfig: CompiledAccountConfig,
  socket: WASocket,
  onMatch: (match: MessageMatch) => void
): (msg: proto.IWebMessageInfo) => void {
  const { authorizedUsers, authorizedGroups, keywordRules } = accountConfig;

  return (msg: proto.IWebMessageInfo): void => {
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const senderJid = msg.key.participant ?? msg.key.remoteJid;
    const groupJid = msg.key.remoteJid;

    if (!senderJid || !groupJid) return;

    const senderPhone = extractPhone(senderJid);
    const groupPhone = extractPhone(groupJid);

    if (!authorizedUsers.has(senderPhone)) return;
    if (!authorizedGroups.has(groupPhone)) return;

    const text = extractText(msg.message);
    if (!text) return;

    for (const rule of keywordRules) {
      if (rule.regex.test(text)) {
        const response = rule.responses[Math.floor(Math.random() * rule.responses.length)];
        
        socket.sendMessage(groupJid, { text: response }, { quoted: msg as any }).catch(console.error);
        
        onMatch({
          account: accountConfig.name,
          groupJid,
          senderJid,
          keyword: rule.matchedKeyword,
          response,
        });
        break;
      }
    }
  };
}

function extractText(message: proto.IMessage): string | null {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return null;
}