import { getPendingReminders, markReminderSent } from './reminders.js';
import { sendWhatsAppMessage } from '../whatsapp/api.js';

/**
 * Procesa recordatorios pendientes y envía mensajes por WhatsApp.
 */
export async function processReminders() {
  try {
    const reminders = await getPendingReminders();
    const now = new Date();

    for (const reminder of reminders) {
      if (reminder.sent) continue;

      const reminderTime = new Date(reminder.reminderTime);

      // Si es hora de enviar el recordatorio
      if (now >= reminderTime) {
        try {
          await sendWhatsAppMessage(reminder.phoneNumber, reminder.message);
          await markReminderSent(reminder.eventId);
          console.log(`[reminders] Recordatorio enviado a ${reminder.phoneNumber}: ${reminder.message}`);
        } catch (err) {
          console.error(`[reminders] Error enviando recordatorio a ${reminder.phoneNumber}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[reminders] Error procesando recordatorios:', err.message);
  }
}

/**
 * Inicia el procesador de recordatorios que se ejecuta cada minuto.
 */
export function startReminderProcessor() {
  console.log('[reminders] Iniciando procesador de recordatorios...');

  // Procesar inmediatamente al iniciar
  processReminders();

  // Procesar cada minuto
  setInterval(processReminders, 60 * 1000);
}