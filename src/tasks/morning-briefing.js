// Backward-compatibility shim: delegates to the new task executor.
// The old morning_briefing config is migrated to a v2 task on startup.
import { getAllTasks } from '../redis/tasks.js';
import { runTask } from './task-executor.js';

/**
 * Runs the "Resumen Matutino" task (first task named that way, or first task).
 * Falls back to legacy config if no v2 tasks exist yet.
 *
 * @param {object} [overrideCfg] - Legacy config override (for dashboard test-run)
 */
export async function runMorningBriefing(overrideCfg) {
  // If caller passed a legacy override config, convert it inline
  if (overrideCfg) {
    const legacyToTask = legacyCfgToTask(overrideCfg);
    return runTask(null, legacyToTask);
  }

  // Find the first "Resumen Matutino" task in the new system
  const tasks = await getAllTasks();
  const mb = tasks.find(t => t.name === 'Resumen Matutino') ?? tasks[0] ?? null;

  if (mb) {
    return runTask(mb.id);
  }

  // No tasks exist yet — nothing to do
  return { success: false, error: 'No hay tareas configuradas aún.' };
}

function legacyCfgToTask(mb) {
  const tools = [];
  const sec = mb.sections ?? {};

  if (sec.weather !== false) {
    tools.push({ id: 'weather', config: { city: 'Córdoba, Argentina' } });
  }
  const newsTopics = [];
  if (sec.news_belgrano  !== false) newsTopics.push('belgrano');
  if (sec.news_cordoba   !== false) newsTopics.push('cordoba');
  if (sec.news_argentina !== false) newsTopics.push('argentina');
  if (newsTopics.length) tools.push({ id: 'news', config: { topics: newsTopics } });
  if (sec.calendar !== false && mb.calendarAccount) {
    tools.push({ id: 'calendar', config: { account: mb.calendarAccount, rangeType: 'day' } });
  }

  return {
    name:  'Resumen Matutino',
    emoji: '🌅',
    phone: mb.phone ?? '',
    tools,
  };
}
