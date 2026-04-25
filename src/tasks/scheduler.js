import cron from 'node-cron';
import { getAllTasks, migrateLegacyConfig } from '../redis/tasks.js';
import { runTask } from './task-executor.js';

const TZ = 'America/Argentina/Buenos_Aires';

let scheduledJobs = {}; // { taskId: cronJob }

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Converts a task's schedule config to a cron expression.
 * schedule.type: 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'custom'
 */
function scheduleToCron(schedule) {
  if (!schedule) return null;

  if (schedule.type === 'custom') {
    return schedule.cron ?? null;
  }

  const [hh, mm] = (schedule.time ?? '07:00').split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return null;
  const base = `${mm} ${hh}`;

  switch (schedule.type) {
    case 'weekdays': return `${base} * * 1-5`;
    case 'weekends': return `${base} * * 0,6`;
    case 'weekly': {
      const days = (schedule.days ?? [1]).sort().join(',');
      return `${base} * * ${days}`;
    }
    default: // 'daily'
      return `${base} * * *`;
  }
}

function cancelJob(id) {
  if (scheduledJobs[id]) {
    scheduledJobs[id].stop();
    delete scheduledJobs[id];
    console.log(`[scheduler] Job cancelado: ${id}`);
  }
}

function scheduleJob(id, cronExpr, fn) {
  if (!cron.validate(cronExpr)) {
    console.warn(`[scheduler] Expresión cron inválida para ${id}: "${cronExpr}"`);
    return;
  }
  cancelJob(id);
  scheduledJobs[id] = cron.schedule(cronExpr, fn, { timezone: TZ });
  console.log(`[scheduler] Job programado: ${id} → "${cronExpr}"`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reads all tasks from Redis and (re)schedules enabled ones.
 * Safe to call multiple times — cancels stale jobs first.
 */
export async function syncScheduler() {
  try {
    const tasks = await getAllTasks();
    const activeIds = new Set();

    for (const task of tasks) {
      if (!task.enabled) {
        cancelJob(task.id);
        continue;
      }

      const cronExpr = scheduleToCron(task.schedule);
      if (!cronExpr) {
        console.warn(`[scheduler] No se pudo calcular cron para tarea: ${task.id}`);
        cancelJob(task.id);
        continue;
      }

      scheduleJob(task.id, cronExpr, async () => {
        console.log(`[scheduler] Ejecutando tarea "${task.name}" (${task.id})...`);
        await runTask(task.id).catch(err =>
          console.error(`[scheduler] Error en tarea ${task.id}:`, err.message)
        );
      });
      activeIds.add(task.id);
    }

    // Cancel jobs for tasks that were deleted
    for (const id of Object.keys(scheduledJobs)) {
      if (!activeIds.has(id)) cancelJob(id);
    }
  } catch (err) {
    console.error('[scheduler] Error sincronizando scheduler:', err.message);
  }
}

export async function startScheduler() {
  await migrateLegacyConfig();
  await syncScheduler();
  console.log('[scheduler] Scheduler iniciado.');
}

export function getScheduledJobs() {
  return Object.keys(scheduledJobs);
}

export function getScheduleDescription(schedule) {
  if (!schedule) return 'Sin configurar';
  if (schedule.type === 'custom') return `Cron: ${schedule.cron ?? '?'}`;

  const time = schedule.time ?? '07:00';
  const DAY_NAMES = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  switch (schedule.type) {
    case 'weekdays': return `Lun–Vie a las ${time}`;
    case 'weekends': return `Sáb–Dom a las ${time}`;
    case 'weekly': {
      const days = (schedule.days ?? []).map(d => DAY_NAMES[d] ?? d).join(', ');
      return `${days} a las ${time}`;
    }
    default: return `Todos los días a las ${time}`;
  }
}
