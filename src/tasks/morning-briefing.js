import { getCordobaWeather, formatWeatherMessage } from '../services/weather.js';
import { getNews, formatNewsMessage } from '../services/news.js';
import { getTasksConfig, updateTask, appendTaskLog } from '../redis/tasks.js';
import { listAllCalendars, getEvents } from '../calendar/client.js';
import { sendWhatsAppMessage } from '../whatsapp/api.js';

const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function formatDateES(date) {
  return `${DAYS_ES[date.getDay()]} ${date.getDate()} de ${MONTHS_ES[date.getMonth()]} de ${date.getFullYear()}`;
}

function formatEventTime(event) {
  // event.start is already a string: "2026-04-23T10:00:00-03:00" (timed) or "2026-04-23" (all-day)
  if (event.start && event.start.includes('T')) {
    const d = new Date(event.start);
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return 'Todo el día';
}

async function getTodayEvents(cfg) {
  if (!cfg.calendarAccount) return [];
  try {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
    const end   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
    const events = await getEvents(cfg.calendarAccount, 'primary', start.toISOString(), end.toISOString());
    return events || [];
  } catch (err) {
    console.warn('[morning-briefing] Error obteniendo eventos del calendario:', err.message);
    return [];
  }
}

function formatCalendarSection(events) {
  if (events.length === 0) return '📅 *Reuniones del día*\nNo tenés reuniones programadas hoy. 🎉';
  const lines = events
    .sort((a, b) => {
      const ta = a.start?.dateTime || a.start?.date || '';
      const tb = b.start?.dateTime || b.start?.date || '';
      return ta.localeCompare(tb);
    })
    .map(e => `• ${formatEventTime(e)} — ${e.summary || 'Sin título'}`)
    .join('\n');
  return `📅 *Reuniones del día*\n${lines}`;
}

/**
 * Builds and sends the morning briefing WhatsApp message.
 * @param {object} [overrideCfg] — optional config override for manual test runs
 * @returns {{ success: boolean, message?: string, error?: string }}
 */
export async function runMorningBriefing(overrideCfg) {
  const allConfig = await getTasksConfig();
  const cfg = overrideCfg ?? allConfig.morning_briefing;

  if (!cfg.phone) {
    const err = 'No hay número de teléfono configurado para el resumen matutino.';
    console.warn('[morning-briefing]', err);
    return { success: false, error: err };
  }

  const sections = cfg.sections ?? {};
  const parts = [];
  const today = new Date();

  // Header
  parts.push(`🌅 *¡Buenos días!*\n📆 ${formatDateES(today).charAt(0).toUpperCase() + formatDateES(today).slice(1)}`);

  const fetchTasks = [];

  if (sections.weather !== false) {
    fetchTasks.push(
      getCordobaWeather()
        .then(w => ({ type: 'weather', data: w }))
        .catch(err => ({ type: 'weather', error: err.message }))
    );
  }

  if (sections.news_belgrano !== false || sections.news_cordoba !== false || sections.news_argentina !== false) {
    fetchTasks.push(
      getNews()
        .then(n => ({ type: 'news', data: n }))
        .catch(err => ({ type: 'news', error: err.message }))
    );
  }

  if (sections.calendar !== false) {
    fetchTasks.push(
      getTodayEvents(cfg)
        .then(e => ({ type: 'calendar', data: e }))
        .catch(err => ({ type: 'calendar', error: err.message }))
    );
  }

  const results = await Promise.all(fetchTasks);

  for (const result of results) {
    if (result.error) {
      console.warn(`[morning-briefing] Error en sección ${result.type}:`, result.error);
      continue;
    }

    if (result.type === 'weather') {
      parts.push(formatWeatherMessage(result.data));
    }

    if (result.type === 'calendar') {
      parts.push(formatCalendarSection(result.data));
    }

    if (result.type === 'news') {
      const { argentina, cordoba, belgrano } = result.data;
      const filtered = {
        belgrano:  sections.news_belgrano  !== false ? belgrano  : [],
        cordoba:   sections.news_cordoba   !== false ? cordoba   : [],
        argentina: sections.news_argentina !== false ? argentina : [],
      };
      const newsText = formatNewsMessage(filtered);
      if (newsText) parts.push(newsText);
    }
  }

  parts.push('━━━━━━━━━━━━━━━━\n_Resumen generado automáticamente por tu bot_ 🤖');

  const message = parts.join('\n\n');

  try {
    await sendWhatsAppMessage(cfg.phone, message);

    await updateTask('morning_briefing', {
      lastRun: new Date().toISOString(),
      lastStatus: 'ok',
      lastError: null,
    });
    await appendTaskLog('morning_briefing', { status: 'ok', chars: message.length });

    console.log('[morning-briefing] Resumen enviado correctamente.');
    return { success: true, message };
  } catch (err) {
    console.error('[morning-briefing] Error enviando mensaje:', err.message);

    await updateTask('morning_briefing', {
      lastRun: new Date().toISOString(),
      lastStatus: 'error',
      lastError: err.message,
    }).catch(() => {});
    await appendTaskLog('morning_briefing', { status: 'error', error: err.message }).catch(() => {});

    return { success: false, error: err.message };
  }
}
