import { getWeatherForCity, formatWeatherMessage } from '../services/weather.js';
import { fetchTopics, formatTopicsMessage, TOPICS as NEWS_TOPICS } from '../services/news.js';
import { getCryptoPrices, formatCryptoMessage, AVAILABLE_COINS } from '../services/crypto.js';
import { getARSRates, formatCurrencyMessage, RATE_TYPES } from '../services/currency.js';
import { getDailyQuote, formatQuoteMessage } from '../services/quote.js';
import { getEvents } from '../calendar/client.js';
import { searchEmails, getUnreadCount } from '../gmail/client.js';
import { getTasks } from './client.js';
import { listConnectedAccounts } from '../auth/google.js';

// ─────────────────────────────────────────────────────────────────────────────
// Calendar helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAYS_ES   = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function todayRange(offsetDays = 0) {
  const nowART = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const base = new Date(nowART.getFullYear(), nowART.getMonth(), nowART.getDate() + offsetDays);
  const y = base.getFullYear(), mo = String(base.getMonth()+1).padStart(2,'0'), d = String(base.getDate()).padStart(2,'0');
  return {
    start: `${y}-${mo}-${d}T00:00:00-03:00`,
    end:   `${y}-${mo}-${d}T23:59:59-03:00`,
    label: `${DAYS_ES[base.getDay()]} ${base.getDate()} de ${MONTHS_ES[base.getMonth()]}`,
  };
}

function rangeFromNow(days) {
  const start = new Date();
  const end   = new Date(start.getTime() + days * 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function formatEventTime(event) {
  if (event.start?.includes('T')) {
    return new Date(event.start).toLocaleTimeString('es-AR', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'America/Argentina/Buenos_Aires',
    });
  }
  return 'Todo el día';
}

async function resolveAccount(configAccount) {
  if (configAccount) return configAccount;
  const accounts = await listConnectedAccounts();
  return accounts[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  // ── 1. Clima ──────────────────────────────────────────────────────────────
  {
    id: 'weather',
    name: 'Clima',
    emoji: '🌤️',
    description: 'Clima actual y pronóstico del día para cualquier ciudad',
    defaultConfig: { city: 'Córdoba, Argentina' },
    configFields: [
      { key: 'city', type: 'text', label: 'Ciudad', placeholder: 'Ej: Buenos Aires, Madrid, New York' },
    ],
    async run(cfg = {}) {
      const city = cfg.city || 'Córdoba, Argentina';
      const w = await getWeatherForCity(city);
      return formatWeatherMessage(w);
    },
  },

  // ── 2. Noticias ───────────────────────────────────────────────────────────
  {
    id: 'news',
    name: 'Noticias',
    emoji: '📰',
    description: 'Titulares de noticias por tema (24 tópicos disponibles)',
    defaultConfig: { topics: ['argentina'] },
    configFields: [
      {
        key: 'topics',
        type: 'multi-select',
        label: 'Temas de noticias',
        options: Object.entries(NEWS_TOPICS).map(([id, t]) => ({ value: id, label: `${t.emoji} ${t.label}` })),
      },
      { key: 'maxPerTopic', type: 'number', label: 'Noticias por tema', min: 1, max: 8, default: 4 },
    ],
    async run(cfg = {}) {
      const topics = cfg.topics?.length ? cfg.topics : ['argentina'];
      const max = cfg.maxPerTopic ?? 4;
      const data = await fetchTopics(topics, max);
      return formatTopicsMessage(data, topics);
    },
  },

  // ── 3. Calendario ─────────────────────────────────────────────────────────
  {
    id: 'calendar',
    name: 'Calendario',
    emoji: '📅',
    description: 'Eventos del día / semana de Google Calendar',
    defaultConfig: { account: '', daysAhead: 0, rangeType: 'day' },
    configFields: [
      { key: 'account',   type: 'account-select', label: 'Cuenta de Google' },
      {
        key: 'rangeType', type: 'select', label: 'Período',
        options: [
          { value: 'day',       label: 'Hoy' },
          { value: 'tomorrow',  label: 'Mañana' },
          { value: '3days',     label: 'Próximos 3 días' },
          { value: 'week',      label: 'Próximos 7 días' },
        ],
      },
    ],
    async run(cfg = {}) {
      const account = await resolveAccount(cfg.account);
      if (!account) return null;

      let startISO, endISO, rangeLabel;
      const rangeType = cfg.rangeType ?? 'day';

      if (rangeType === 'tomorrow') {
        const { start, end, label } = todayRange(1);
        startISO = start; endISO = end; rangeLabel = label;
      } else if (rangeType === '3days') {
        const { start, end } = rangeFromNow(3);
        startISO = start; endISO = end; rangeLabel = 'próximos 3 días';
      } else if (rangeType === 'week') {
        const { start, end } = rangeFromNow(7);
        startISO = start; endISO = end; rangeLabel = 'próximos 7 días';
      } else {
        const { start, end, label } = todayRange(0);
        startISO = start; endISO = end; rangeLabel = label;
      }

      try {
        const events = await getEvents(account, 'primary', startISO, endISO);
        if (!events?.length) return `📅 *Calendario (${rangeLabel})*\nNo hay eventos. 🎉`;

        const lines = events
          .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
          .map(e => `• ${formatEventTime(e)} — ${e.summary || 'Sin título'}`)
          .join('\n');
        return `📅 *Calendario (${rangeLabel})*\n${lines}`;
      } catch (err) {
        console.warn('[tool:calendar] Error:', err.message);
        return null;
      }
    },
  },

  // ── 4. Gmail ──────────────────────────────────────────────────────────────
  {
    id: 'gmail',
    name: 'Gmail',
    emoji: '📧',
    description: 'Resumen de emails sin leer',
    defaultConfig: { account: '', maxEmails: 5 },
    configFields: [
      { key: 'account',   type: 'account-select', label: 'Cuenta de Google' },
      { key: 'maxEmails', type: 'number', label: 'Máx. emails a mostrar', min: 1, max: 20, default: 5 },
    ],
    async run(cfg = {}) {
      const account = await resolveAccount(cfg.account);
      if (!account) return null;
      const max = cfg.maxEmails ?? 5;

      try {
        const { unreadCount } = await getUnreadCount(account);
        if (!unreadCount) return `📧 *Gmail*\n✅ Sin emails sin leer en ${account}`;

        const emails = await searchEmails(account, 'is:unread in:inbox', max);
        if (!emails?.length) return `📧 *Gmail*\n📬 ${unreadCount} sin leer en ${account}`;

        const lines = emails
          .slice(0, max)
          .map(e => `• *${(e.from || 'Desconocido').split('<')[0].trim()}* — ${e.subject || '(sin asunto)'}`)
          .join('\n');
        return `📧 *Gmail — ${unreadCount} sin leer*\n${lines}`;
      } catch (err) {
        console.warn('[tool:gmail] Error:', err.message);
        return null;
      }
    },
  },

  // ── 5. Google Tasks ───────────────────────────────────────────────────────
  {
    id: 'gtasks',
    name: 'Tareas Google',
    emoji: '✅',
    description: 'Tareas pendientes de Google Tasks',
    defaultConfig: { account: '', maxTasks: 10 },
    configFields: [
      { key: 'account',  type: 'account-select', label: 'Cuenta de Google' },
      { key: 'maxTasks', type: 'number', label: 'Máx. tareas a mostrar', min: 1, max: 30, default: 10 },
    ],
    async run(cfg = {}) {
      const account = await resolveAccount(cfg.account);
      if (!account) return null;
      const max = cfg.maxTasks ?? 10;

      try {
        const tasks = await getTasks(account, '@default', false);
        if (!tasks?.length) return `✅ *Tareas pendientes*\n¡Sin tareas pendientes! 🎉`;

        const lines = tasks.slice(0, max).map(t => `• ${t.title || 'Sin título'}`).join('\n');
        const total = tasks.length;
        const extra = total > max ? `\n_... y ${total - max} más_` : '';
        return `✅ *Tareas pendientes (${total})*\n${lines}${extra}`;
      } catch (err) {
        console.warn('[tool:gtasks] Error:', err.message);
        return null;
      }
    },
  },

  // ── 6. Criptomonedas ──────────────────────────────────────────────────────
  {
    id: 'crypto',
    name: 'Cripto',
    emoji: '₿',
    description: 'Precios actuales de criptomonedas (USD + variación 24h)',
    defaultConfig: { coins: ['BTC', 'ETH'] },
    configFields: [
      {
        key: 'coins',
        type: 'multi-select',
        label: 'Criptomonedas',
        options: AVAILABLE_COINS.map(c => ({ value: c, label: c })),
      },
    ],
    async run(cfg = {}) {
      const coins = cfg.coins?.length ? cfg.coins : ['BTC', 'ETH'];
      const prices = await getCryptoPrices(coins);
      return formatCryptoMessage(prices, coins) || null;
    },
  },

  // ── 7. Cotizaciones ARS ───────────────────────────────────────────────────
  {
    id: 'currency',
    name: 'Cotizaciones',
    emoji: '💱',
    description: 'Cotizaciones del dólar (oficial, blue, MEP, etc.)',
    defaultConfig: { types: ['oficial', 'blue'] },
    configFields: [
      {
        key: 'types',
        type: 'multi-select',
        label: 'Tipos de cambio',
        options: RATE_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })),
      },
    ],
    async run(cfg = {}) {
      const types = cfg.types?.length ? cfg.types : ['oficial', 'blue'];
      const rates = await getARSRates();
      return formatCurrencyMessage(rates, types) || null;
    },
  },

  // ── 8. Frase del día ──────────────────────────────────────────────────────
  {
    id: 'quote',
    name: 'Frase del día',
    emoji: '💬',
    description: 'Frase motivacional o inspiracional del día',
    defaultConfig: {},
    configFields: [],
    async run() {
      const q = await getDailyQuote();
      return formatQuoteMessage(q);
    },
  },

  // ── 9. Mensaje personalizado ──────────────────────────────────────────────
  {
    id: 'custom',
    name: 'Mensaje personalizado',
    emoji: '✏️',
    description: 'Texto fijo que siempre se incluye en el envío',
    defaultConfig: { text: '' },
    configFields: [
      { key: 'text', type: 'textarea', label: 'Texto', placeholder: 'Escribí tu mensaje aquí...' },
    ],
    async run(cfg = {}) {
      return cfg.text?.trim() || null;
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────

const TOOL_MAP = new Map(TOOLS.map(t => [t.id, t]));

export function getToolById(id) {
  return TOOL_MAP.get(id) ?? null;
}

export function getAllTools() {
  return TOOLS;
}

/** Lightweight descriptor for the dashboard (no `run` function) */
export function getToolDescriptors() {
  return TOOLS.map(({ id, name, emoji, description, defaultConfig, configFields }) => ({
    id, name, emoji, description, defaultConfig, configFields,
  }));
}
