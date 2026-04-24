import { getRedisClient } from '../redis/client.js';

const CONVERSATION_TTL_SECONDS = 4 * 60 * 60; // 4 horas
const MAX_HISTORY_MESSAGES = 12;

/**
 * Trims history to MAX_HISTORY_MESSAGES, always starting from a `user` message
 * so tool_use/tool_result pairs are never split across the cut boundary.
 */
function trimHistory(history) {
  const trimmed = history.length > MAX_HISTORY_MESSAGES
    ? history.slice(-MAX_HISTORY_MESSAGES)
    : [...history];
  // Always ensure history starts at a user message to avoid orphaned tool_result blocks
  // at the beginning (happens when the trim boundary cuts the preceding assistant+tool_calls).
  const firstUser = trimmed.findIndex(m => m.role === 'user');
  const result = firstUser > 0 ? trimmed.slice(firstUser) : trimmed;
  if (result.length !== history.length) {
    console.log(`[store] trimHistory: ${history.length} → ${result.length} msgs (firstUser=${firstUser})`);
  }
  return result;
}

/**
 * Obtiene el historial de conversación para un número de WhatsApp.
 * @param {string} phoneNumber - Número en formato internacional (ej: 549XXXXXXXXXX)
 * @returns {Array} Arreglo de mensajes { role, content }
 */
export async function getHistory(phoneNumber) {
  const redis = await getRedisClient();
  const key = `conv:${phoneNumber}`;
  const raw = await redis.get(key);
  if (!raw) {
    console.log(`[store] getHistory ${phoneNumber.slice(-4)}: vacío`);
    return [];
  }
  try {
    const history = JSON.parse(raw);
    const roles = history.map(m => m.role[0]).join('');  // e.g. "uatatat"
    console.log(`[store] getHistory ${phoneNumber.slice(-4)}: ${history.length} msgs  roles="${roles}"`);
    return history;
  } catch {
    console.error(`[store] getHistory ${phoneNumber.slice(-4)}: JSON inválido, retornando vacío`);
    return [];
  }
}

/**
 * Replaces the full conversation history atomically, trimming intelligently.
 * Prefer this over appendMessage to avoid orphaned tool_result blocks.
 * @param {string} phoneNumber
 * @param {Array} history
 */
export async function setHistory(phoneNumber, history) {
  const redis = await getRedisClient();
  const key = `conv:${phoneNumber}`;
  const trimmed = trimHistory(history);
  const lastRole = trimmed.length > 0 ? trimmed[trimmed.length - 1].role : 'none';
  console.log(`[store] setHistory ${phoneNumber.slice(-4)}: guardando ${trimmed.length} msgs  último_role=${lastRole}`);
  await redis.set(key, JSON.stringify(trimmed), { EX: CONVERSATION_TTL_SECONDS });
}

/**
 * Limpia el historial de un número (útil para testing o comando "reset").
 */
export async function clearHistory(phoneNumber) {
  const redis = await getRedisClient();
  await redis.del(`conv:${phoneNumber}`);
}

// ─── Log de mensajes para el dashboard ───────────────────────────────────────

const MAX_LOG_ENTRIES = 50;

/**
 * Guarda un mensaje entrante y su respuesta en el log del dashboard.
 */
export async function logMessage(from, text, response, success) {
  const redis = await getRedisClient();
  const entry = JSON.stringify({
    from:      from.slice(-4).padStart(10, '*'), // ocultar número completo
    text:      text.slice(0, 200),
    response:  response?.slice(0, 300),
    success,
    timestamp: new Date().toISOString(),
  });
  await redis.lPush('msgs:log', entry);
  await redis.lTrim('msgs:log', 0, MAX_LOG_ENTRIES - 1);
}

/**
 * Obtiene los últimos N mensajes del log.
 */
export async function getMessageLog(count = 20) {
  const redis = await getRedisClient();
  const raw = await redis.lRange('msgs:log', 0, count - 1);
  return raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}
