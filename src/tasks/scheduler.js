import cron from 'node-cron';
import { getTasksConfig } from '../redis/tasks.js';
import { runMorningBriefing } from './morning-briefing.js';

let scheduledJobs = {};

/**
 * Parses "HH:MM" and returns a cron expression "MM HH * * *".
 */
function timeToCron(time) {
  const [hh, mm] = time.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) throw new Error(`Hora inválida: ${time}`);
  return `${mm} ${hh} * * *`;
}

function cancelJob(id) {
  if (scheduledJobs[id]) {
    scheduledJobs[id].stop();
    delete scheduledJobs[id];
    console.log(`[scheduler] Job cancelado: ${id}`);
  }
}

function scheduleJob(id, cronExpr, fn) {
  cancelJob(id);
  scheduledJobs[id] = cron.schedule(cronExpr, fn, {
    timezone: 'America/Argentina/Buenos_Aires',
  });
  console.log(`[scheduler] Job programado: ${id} → cron "${cronExpr}"`);
}

/**
 * Reads task config from Redis and (re)schedules all enabled tasks.
 * Safe to call multiple times — cancels existing jobs first.
 */
export async function syncScheduler() {
  try {
    const config = await getTasksConfig();
    const mb = config.morning_briefing;

    if (mb.enabled && mb.time) {
      scheduleJob('morning_briefing', timeToCron(mb.time), async () => {
        console.log('[scheduler] Ejecutando resumen matutino...');
        await runMorningBriefing().catch(err =>
          console.error('[scheduler] Error en resumen matutino:', err.message)
        );
      });
    } else {
      cancelJob('morning_briefing');
    }
  } catch (err) {
    console.error('[scheduler] Error sincronizando scheduler:', err.message);
  }
}

export function startScheduler() {
  syncScheduler();
  console.log('[scheduler] Scheduler iniciado.');
}

export function getScheduledJobs() {
  return Object.keys(scheduledJobs);
}
