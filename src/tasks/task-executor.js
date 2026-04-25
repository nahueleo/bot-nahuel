import { getToolById } from './tool-registry.js';
import { getTaskById, updateTask, appendTaskLog } from '../redis/tasks.js';
import { sendWhatsAppMessage } from '../whatsapp/api.js';

const DAYS_ES   = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function formatDateES(date) {
  const d = new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const str = `${DAYS_ES[d.getDay()]} ${d.getDate()} de ${MONTHS_ES[d.getMonth()]} de ${d.getFullYear()}`;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Runs a scheduled task: fetches each tool's output in parallel, assembles the
 * message and sends it via WhatsApp.
 *
 * @param {string|null} taskId   - Redis task ID. Pass null when using overrideTask.
 * @param {object|null} overrideTask - Full task object for dry-run / preview.
 * @returns {{ success: boolean, message?: string, error?: string }}
 */
export async function runTask(taskId, overrideTask = null) {
  let task = overrideTask;

  if (!task && taskId) {
    task = await getTaskById(taskId);
  }

  if (!task) return { success: false, error: `Tarea ${taskId ?? '?'} no encontrada` };
  if (!task.phone) return { success: false, error: 'No hay número de teléfono configurado' };

  const today = new Date();
  const parts = [];

  // Header
  const emoji = task.emoji || '🤖';
  const name  = task.name  || 'Resumen';
  parts.push(`${emoji} *${name}*\n📆 ${formatDateES(today)}`);

  // Run all tools in parallel
  const toolEntries = task.tools ?? [];
  const toolResults = await Promise.all(
    toolEntries.map(async ({ id, config }) => {
      const tool = getToolById(id);
      if (!tool) {
        console.warn(`[task-executor] Tool desconocida: ${id}`);
        return null;
      }
      try {
        return await tool.run(config ?? {});
      } catch (err) {
        console.warn(`[task-executor] Error en tool "${id}":`, err.message);
        return null;
      }
    })
  );

  for (const result of toolResults) {
    if (result && typeof result === 'string' && result.trim()) {
      parts.push(result.trim());
    }
  }

  parts.push('━━━━━━━━━━━━━━━━\n_Enviado automáticamente por tu bot_ 🤖');

  const message = parts.join('\n\n');

  try {
    await sendWhatsAppMessage(task.phone, message);

    if (!overrideTask && taskId) {
      await updateTask(taskId, {
        lastRun: new Date().toISOString(),
        lastStatus: 'ok',
        lastError: null,
      });
      await appendTaskLog(taskId, { status: 'ok', chars: message.length });
    }

    return { success: true, message };
  } catch (err) {
    console.error('[task-executor] Error enviando WhatsApp:', err.message);

    if (!overrideTask && taskId) {
      await updateTask(taskId, {
        lastRun: new Date().toISOString(),
        lastStatus: 'error',
        lastError: err.message,
      }).catch(() => {});
      await appendTaskLog(taskId, { status: 'error', error: err.message }).catch(() => {});
    }

    return { success: false, error: err.message };
  }
}
