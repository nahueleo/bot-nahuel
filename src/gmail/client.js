import { google } from 'googleapis';
import { getAuthClient } from '../auth/google.js';

async function getGmailClient(accountName) {
  const auth = await getAuthClient(accountName);
  if (!auth) throw new Error(`Cuenta "${accountName}" no conectada. Autenticá primero en /auth/google?account=${accountName}`);
  return google.gmail({ version: 'v1', auth });
}

function parseHeaders(headers = []) {
  const get = (name) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    from:    get('From'),
    to:      get('To'),
    subject: get('Subject'),
    date:    get('Date'),
  };
}

function decodeBody(payload) {
  if (!payload) return '';

  // Texto plano directo
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8').trim();
  }

  // Buscar text/plain en partes
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8').trim();
      }
    }
    // Fallback: text/html si no hay plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
      }
    }
  }

  return '';
}

/**
 * Busca emails usando la sintaxis de búsqueda de Gmail.
 * query puede ser: "is:unread", "from:juan@gmail.com", "subject:reunión", etc.
 */
export async function searchEmails(accountName, query = '', maxResults = 10) {
  const gmail = await getGmailClient(accountName);

  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: Math.min(maxResults, 20),
  });

  if (!data.messages || data.messages.length === 0) {
    return [];
  }

  // Obtener metadata de cada mensaje en paralelo
  const emails = await Promise.all(
    data.messages.map(async ({ id }) => {
      const { data: msg } = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      const headers = parseHeaders(msg.payload?.headers);
      return {
        id: msg.id,
        threadId: msg.threadId,
        snippet: msg.snippet || '',
        labels: msg.labelIds || [],
        isUnread: (msg.labelIds || []).includes('UNREAD'),
        from:    headers.from,
        to:      headers.to,
        subject: headers.subject,
        date:    headers.date,
      };
    }),
  );

  return emails;
}

/**
 * Obtiene el contenido completo de un email por su ID.
 */
export async function getEmail(accountName, messageId) {
  const gmail = await getGmailClient(accountName);

  const { data: msg } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const headers = parseHeaders(msg.payload?.headers);
  const body = decodeBody(msg.payload);

  return {
    id: msg.id,
    threadId: msg.threadId,
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
    isUnread: (msg.labelIds || []).includes('UNREAD'),
    from:    headers.from,
    to:      headers.to,
    subject: headers.subject,
    date:    headers.date,
    body:    body.slice(0, 2000),
  };
}

/**
 * Marca un email como leído.
 */
export async function markAsRead(accountName, messageId) {
  const gmail = await getGmailClient(accountName);

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    resource: { removeLabelIds: ['UNREAD'] },
  });

  return { marked: true, messageId };
}

/**
 * Mueve un email a la papelera.
 */
export async function trashEmail(accountName, messageId) {
  const gmail = await getGmailClient(accountName);

  await gmail.users.messages.trash({
    userId: 'me',
    id: messageId,
  });

  return { trashed: true, messageId };
}

/**
 * Devuelve el conteo de emails no leídos en la bandeja de entrada.
 */
export async function getUnreadCount(accountName) {
  const gmail = await getGmailClient(accountName);

  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread in:inbox',
    maxResults: 1,
  });

  return {
    unreadCount: data.resultSizeEstimate || 0,
    hasMore: (data.resultSizeEstimate || 0) > 0,
  };
}
