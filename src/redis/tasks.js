import { getRedisClient } from './client.js';

// ─── Key schema ───────────────────────────────────────────────────────────────
// tasks:v2:index            → JSON array of task IDs
// tasks:v2:{id}             → JSON task object
// tasks:log:v2:{id}         → List of up to MAX_LOG log entries (newest first)
// tasks:config (legacy)     → kept for backward compat, read-once migration only

const INDEX_KEY    = 'tasks:v2:index';
const TASK_PREFIX  = 'tasks:v2:';
const LOG_PREFIX   = 'tasks:log:v2:';
const LEGACY_KEY   = 'tasks:config';
const MAX_LOG      = 30;

// ─── ID generation ────────────────────────────────────────────────────────────
import { randomUUID } from 'crypto';

export function newTaskId() {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/** Returns all task IDs from the index. */
export async function getTaskIds() {
  const redis = await getRedisClient();
  const raw = await redis.get(INDEX_KEY);
  try { return JSON.parse(raw) ?? []; } catch { return []; }
}

/** Returns a single task by ID, or null if not found. */
export async function getTaskById(id) {
  const redis = await getRedisClient();
  const raw = await redis.get(`${TASK_PREFIX}${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Returns all tasks as an array, in index order. */
export async function getAllTasks() {
  const ids = await getTaskIds();
  if (!ids.length) return [];
  const redis = await getRedisClient();
  const raws  = await Promise.all(ids.map(id => redis.get(`${TASK_PREFIX}${id}`)));
  return raws
    .map((raw, i) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
    .filter(Boolean);
}

/** Creates a new task. Returns the created task. */
export async function createTask(taskData) {
  const redis = await getRedisClient();
  const id    = taskData.id ?? newTaskId();
  const now   = new Date().toISOString();
  const task  = {
    id,
    name:       taskData.name       ?? 'Nueva tarea',
    emoji:      taskData.emoji      ?? '🤖',
    enabled:    taskData.enabled    ?? false,
    schedule:   taskData.schedule   ?? { type: 'daily', time: '07:00' },
    phone:      taskData.phone      ?? '',
    tools:      taskData.tools      ?? [],
    createdAt:  taskData.createdAt  ?? now,
    lastRun:    null,
    lastStatus: null,
    lastError:  null,
  };

  await redis.set(`${TASK_PREFIX}${id}`, JSON.stringify(task));

  // Add to index
  const ids = await getTaskIds();
  if (!ids.includes(id)) {
    ids.push(id);
    await redis.set(INDEX_KEY, JSON.stringify(ids));
  }

  return task;
}

/** Updates specific fields of an existing task. */
export async function updateTask(id, updates) {
  const task = await getTaskById(id);
  if (!task) throw new Error(`Tarea no encontrada: ${id}`);
  const updated = { ...task, ...updates, id }; // prevent id overwrite
  const redis = await getRedisClient();
  await redis.set(`${TASK_PREFIX}${id}`, JSON.stringify(updated));
  return updated;
}

/** Deletes a task and removes it from the index. */
export async function deleteTask(id) {
  const redis = await getRedisClient();
  await redis.del(`${TASK_PREFIX}${id}`);
  await redis.del(`${LOG_PREFIX}${id}`);
  const ids = (await getTaskIds()).filter(i => i !== id);
  await redis.set(INDEX_KEY, JSON.stringify(ids));
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export async function appendTaskLog(taskId, entry) {
  const redis = await getRedisClient();
  const key = `${LOG_PREFIX}${taskId}`;
  await redis.lPush(key, JSON.stringify({ ...entry, ts: new Date().toISOString() }));
  await redis.lTrim(key, 0, MAX_LOG - 1);
}

export async function getTaskLog(taskId) {
  const redis = await getRedisClient();
  const items = await redis.lRange(`${LOG_PREFIX}${taskId}`, 0, MAX_LOG - 1);
  return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
}

// ─── Legacy migration ─────────────────────────────────────────────────────────

/**
 * One-time migration from the old `tasks:config` key.
 * Called at startup; safe to call multiple times.
 */
export async function migrateLegacyConfig() {
  const redis = await getRedisClient();

  // Skip if new index already has entries
  const existing = await getTaskIds();
  if (existing.length) return;

  const raw = await redis.get(LEGACY_KEY);
  if (!raw) return;

  try {
    const cfg = JSON.parse(raw);
    const mb  = cfg.morning_briefing;
    if (!mb) return;

    // Build tool list from legacy sections
    const tools = [];
    const sec = mb.sections ?? {};

    if (sec.weather !== false) {
      tools.push({ id: 'weather', config: { city: 'Córdoba, Argentina' } });
    }
    const newsTopics = [];
    if (sec.news_belgrano !== false) newsTopics.push('belgrano');
    if (sec.news_cordoba  !== false) newsTopics.push('cordoba');
    if (sec.news_argentina!== false) newsTopics.push('argentina');
    if (newsTopics.length) {
      tools.push({ id: 'news', config: { topics: newsTopics } });
    }
    if (sec.calendar !== false && mb.calendarAccount) {
      tools.push({ id: 'calendar', config: { account: mb.calendarAccount, rangeType: 'day' } });
    }

    await createTask({
      name:    'Resumen Matutino',
      emoji:   '🌅',
      enabled: mb.enabled ?? false,
      schedule: { type: 'daily', time: mb.time ?? '07:00' },
      phone:   mb.phone ?? '',
      tools,
      createdAt: new Date().toISOString(),
    });

    console.log('[tasks] Migración desde legacy tasks:config completada.');
  } catch (err) {
    console.warn('[tasks] Error en migración legacy:', err.message);
  }
}

// ─── Backward-compat shims (used by morning-briefing.js) ─────────────────────

export async function getTasksConfig() {
  const tasks = await getAllTasks();
  const mb = tasks.find(t => t.name === 'Resumen Matutino') ?? null;
  if (!mb) {
    return {
      morning_briefing: {
        enabled: false, time: '07:00', phone: '', calendarAccount: '',
        sections: { weather: true, news_belgrano: true, news_cordoba: true, news_argentina: true, calendar: true },
        lastRun: null, lastStatus: null, lastError: null,
      },
    };
  }

  // Rebuild legacy shape
  const newsTools = mb.tools.filter(t => t.id === 'news').flatMap(t => t.config?.topics ?? []);
  const calTool   = mb.tools.find(t => t.id === 'calendar');
  return {
    morning_briefing: {
      id:              mb.id,
      enabled:         mb.enabled,
      time:            mb.schedule?.time ?? '07:00',
      phone:           mb.phone,
      calendarAccount: calTool?.config?.account ?? '',
      sections: {
        weather:       mb.tools.some(t => t.id === 'weather'),
        news_belgrano: newsTools.includes('belgrano'),
        news_cordoba:  newsTools.includes('cordoba'),
        news_argentina:newsTools.includes('argentina'),
        calendar:      !!calTool,
      },
      lastRun:    mb.lastRun,
      lastStatus: mb.lastStatus,
      lastError:  mb.lastError,
    },
  };
}

export { updateTask as updateTaskLegacy };
