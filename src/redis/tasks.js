import { getRedisClient } from './client.js';

const CONFIG_KEY = 'tasks:config';
const LOG_PREFIX  = 'tasks:log:';
const MAX_LOG_ENTRIES = 20;

const DEFAULT_CONFIG = {
  morning_briefing: {
    enabled: false,
    time: '07:00',
    phone: '',
    calendarAccount: '',
    sections: {
      weather: true,
      news_belgrano: true,
      news_cordoba: true,
      news_argentina: true,
      calendar: true,
    },
    lastRun: null,
    lastStatus: null,
    lastError: null,
  },
};

export async function getTasksConfig() {
  const redis = await getRedisClient();
  const raw = await redis.get(CONFIG_KEY);
  if (!raw) return structuredClone(DEFAULT_CONFIG);
  try {
    const stored = JSON.parse(raw);
    // Merge with defaults so new fields appear automatically
    return {
      morning_briefing: { ...DEFAULT_CONFIG.morning_briefing, ...stored.morning_briefing },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function saveTasksConfig(config) {
  const redis = await getRedisClient();
  await redis.set(CONFIG_KEY, JSON.stringify(config));
}

export async function updateTask(taskId, updates) {
  const config = await getTasksConfig();
  if (!config[taskId]) throw new Error(`Tarea desconocida: ${taskId}`);
  config[taskId] = { ...config[taskId], ...updates };
  await saveTasksConfig(config);
  return config[taskId];
}

export async function appendTaskLog(taskId, entry) {
  const redis = await getRedisClient();
  const key = `${LOG_PREFIX}${taskId}`;
  const log = { ...entry, ts: new Date().toISOString() };
  await redis.lPush(key, JSON.stringify(log));
  await redis.lTrim(key, 0, MAX_LOG_ENTRIES - 1);
}

export async function getTaskLog(taskId) {
  const redis = await getRedisClient();
  const key = `${LOG_PREFIX}${taskId}`;
  const items = await redis.lRange(key, 0, MAX_LOG_ENTRIES - 1);
  return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
}
