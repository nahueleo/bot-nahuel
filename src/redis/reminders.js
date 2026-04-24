import { getRedisClient } from './client.js';

/**
 * Almacena un recordatorio para un evento.
 * @param {string} eventId
 * @param {string} phoneNumber
 * @param {Date} reminderTime
 * @param {string} message
 */
export async function scheduleReminder(eventId, phoneNumber, reminderTime, message) {
  const redis = await getRedisClient();

  const key = `reminder:${eventId}`;
  const data = {
    phoneNumber,
    reminderTime: reminderTime.toISOString(),
    message,
    sent: false,
  };

  await redis.set(key, JSON.stringify(data));
  console.log(`[reminders] Recordatorio programado para evento ${eventId} a las ${reminderTime.toLocaleString('es-AR')}`);
}

/**
 * Obtiene todos los recordatorios pendientes.
 * @returns {Array<{eventId, phoneNumber, reminderTime, message, sent}>}
 */
export async function getPendingReminders() {
  const redis = await getRedisClient();
  const keys = await redis.keys('reminder:*');

  const reminders = [];
  for (const key of keys) {
    const data = await redis.get(key);
    if (data) {
      try {
        const reminder = JSON.parse(data);
        const eventId = key.replace('reminder:', '');
        reminders.push({ eventId, ...reminder });
      } catch (err) {
        console.error(`[reminders] Error parseando recordatorio ${key}:`, err.message);
      }
    }
  }

  return reminders;
}

/**
 * Marca un recordatorio como enviado.
 * @param {string} eventId
 */
export async function markReminderSent(eventId) {
  const redis = await getRedisClient();
  const key = `reminder:${eventId}`;

  const data = await redis.get(key);
  if (data) {
    const reminder = JSON.parse(data);
    reminder.sent = true;
    await redis.set(key, JSON.stringify(reminder));
    console.log(`[reminders] Recordatorio marcado como enviado: ${eventId}`);
  }
}

/**
 * Elimina un recordatorio.
 * @param {string} eventId
 */
export async function deleteReminder(eventId) {
  const redis = await getRedisClient();
  const key = `reminder:${eventId}`;
  await redis.del(key);
  console.log(`[reminders] Recordatorio eliminado: ${eventId}`);
}