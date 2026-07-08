import { getRedisClient } from './client.js';

const MENU_PREFIX = 'weekly_menu:v1:';
const INDEX_KEY = 'weekly_menu:v1:index';

export function getCurrentWeekId(date = new Date()) {
  const art = new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const day = art.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(art.getFullYear(), art.getMonth(), art.getDate() + diff);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const d = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function getWeeklyMenu(weekId = getCurrentWeekId()) {
  const redis = await getRedisClient();
  const raw = await redis.get(`${MENU_PREFIX}${weekId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function saveWeeklyMenu(menu) {
  const redis = await getRedisClient();
  const weekId = menu.weekId || getCurrentWeekId();
  const now = new Date().toISOString();
  const stored = {
    ...menu,
    weekId,
    createdAt: menu.createdAt || now,
    updatedAt: now,
  };

  await redis.set(`${MENU_PREFIX}${weekId}`, JSON.stringify(stored));

  const rawIndex = await redis.get(INDEX_KEY);
  let index = [];
  try { index = JSON.parse(rawIndex) || []; } catch { index = []; }
  if (!index.includes(weekId)) {
    index.unshift(weekId);
    await redis.set(INDEX_KEY, JSON.stringify(index.slice(0, 24)));
  }

  return stored;
}

export async function listWeeklyMenus() {
  const redis = await getRedisClient();
  const raw = await redis.get(INDEX_KEY);
  try { return JSON.parse(raw) || []; } catch { return []; }
}
