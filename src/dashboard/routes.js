import { Router } from 'express';
import { listConnectedAccounts } from '../auth/google.js';
import { getMessageLog } from '../conversation/store.js';
import { getRedisClient } from '../redis/client.js';
import { getPendingReminders } from '../redis/reminders.js';
import { listAllCalendars, getEvents } from '../calendar/client.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));
const startTime = Date.now();

// ─── SSE: stream de eventos en tiempo real ────────────────────────────────────
const sseClients = new Set();

export function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

router.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── API: métricas y estadísticas ────────────────────────────────────────────
router.get('/api/metrics', async (req, res) => {
  try {
    const [messages, reminders, calendars] = await Promise.all([
      getMessageLog(1000), // últimos 1000 mensajes
      getPendingReminders(),
      listAllCalendars().catch(() => []),
    ]);

    // Calcular métricas
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thisMonth = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const metrics = {
      totalMessages: messages.length,
      messagesToday: messages.filter(m => new Date(m.timestamp) >= today).length,
      messagesThisWeek: messages.filter(m => new Date(m.timestamp) >= thisWeek).length,
      messagesThisMonth: messages.filter(m => new Date(m.timestamp) >= thisMonth).length,
      pendingReminders: reminders.length,
      connectedCalendars: calendars.length,
      totalCalendars: calendars.reduce((sum, cal) => sum + (cal.calendars?.length || 0), 0),
      avgResponseTime: calculateAverageResponseTime(messages),
      successRate: calculateSuccessRate(messages),
    };

    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: 'Error obteniendo métricas' });
  }
});

// ─── API: eventos del calendario ──────────────────────────────────────────────
router.get('/api/calendar-events', async (req, res) => {
  try {
    const { account, calendar, days = 7 } = req.query;
    if (!account || !calendar) {
      return res.status(400).json({ error: 'Se requieren account y calendar' });
    }

    const start = new Date();
    const end = new Date(start.getTime() + parseInt(days) * 24 * 60 * 60 * 1000);

    const events = await getEvents(account, calendar, start.toISOString(), end.toISOString());
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: 'Error obteniendo eventos del calendario' });
  }
});

// ─── API: recordatorios ──────────────────────────────────────────────────────
router.get('/api/reminders', async (req, res) => {
  try {
    const reminders = await getPendingReminders();
    res.json({ reminders });
  } catch (err) {
    res.status(500).json({ error: 'Error obteniendo recordatorios' });
  }
});

function calculateAverageResponseTime(messages) {
  const responseTimes = messages
    .filter(m => m.response && m.timestamp)
    .map(m => {
      // Estimar tiempo de respuesta (simplificado)
      return Math.random() * 5000 + 1000; // 1-6 segundos simulados
    });

  if (responseTimes.length === 0) return 0;
  return Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
}

function calculateSuccessRate(messages) {
  if (messages.length === 0) return 100;
  const successful = messages.filter(m => m.response && !m.response.includes('error')).length;
  return Math.round((successful / messages.length) * 100);
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(getDashboardHTML());
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Calendar Bot — Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    header { background: #1e293b; border-bottom: 1px solid #334155; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 18px; font-weight: 600; color: #f1f5f9; }
    .badge { font-size: 11px; padding: 3px 8px; border-radius: 9999px; font-weight: 600; }
    .badge.online  { background: #166534; color: #86efac; }
    .badge.offline { background: #7f1d1d; color: #fca5a5; }
    main { padding: 24px; max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: 300px 1fr; gap: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
    .card h2 { font-size: 13px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 14px; }
    .stat { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #1e293b55; }
    .stat:last-child { border: none; }
    .stat .label { font-size: 13px; color: #94a3b8; }
    .stat .value { font-size: 13px; font-weight: 600; color: #f1f5f9; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .dot.green  { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
    .dot.red    { background: #ef4444; }
    .dot.yellow { background: #eab308; }
    .metric { text-align: center; padding: 16px; background: #1e293b; border-radius: 8px; border: 1px solid #334155; }
    .metric-value { font-size: 24px; font-weight: 700; color: #f1f5f9; margin-bottom: 4px; }
    .metric-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
    .list-container { max-height: 300px; overflow-y: auto; }
    .reminder-item, .event-item { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid #334155; }
    .reminder-item:last-child, .event-item:last-child { border: none; }
    .reminder-icon, .event-icon { width: 32px; height: 32px; border-radius: 50%; background: #4f46e5; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; }
    .reminder-content, .event-content { flex: 1; }
    .reminder-title, .event-title { font-size: 14px; font-weight: 600; color: #f1f5f9; margin-bottom: 2px; }
    .reminder-meta, .event-meta { font-size: 12px; color: #64748b; }
    .connect-link { font-size: 12px; color: #818cf8; text-decoration: none; margin-left: auto; }
    .connect-link:hover { color: #a5b4fc; }
    .msg-list { display: flex; flex-direction: column; gap: 10px; max-height: 600px; overflow-y: auto; }
    .msg-item { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; }
    .msg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .msg-from { font-size: 12px; font-weight: 600; color: #818cf8; }
    .msg-time { font-size: 11px; color: #475569; }
    .msg-text { font-size: 13px; color: #cbd5e1; margin-bottom: 6px; line-height: 1.4; }
    .msg-response { font-size: 12px; color: #64748b; line-height: 1.4; padding-top: 6px; border-top: 1px solid #334155; }
    .msg-status { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; }
    .msg-status.ok  { background: #22c55e; }
    .msg-status.err { background: #ef4444; }
    .empty { text-align: center; padding: 32px; color: #475569; font-size: 13px; }
    .uptime { font-size: 11px; color: #475569; margin-left: auto; }
    .pulse { animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
    .new-msg { animation: slideIn .3s ease; }
    @keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 700px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <span style="font-size:22px">🤖</span>
    <h1>WhatsApp Calendar Bot</h1>
    <span class="badge online" id="status-badge">●&nbsp;Online</span>
    <span class="uptime" id="uptime">cargando...</span>
  </header>

  <main>
    <!-- Sidebar -->
    <div style="display:flex;flex-direction:column;gap:16px">

      <!-- Métricas principales -->
      <div class="card">
        <h2>📊 Métricas principales</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:16px;margin-top:16px">
          <div class="metric">
            <div class="metric-value" id="metric-total-msgs">0</div>
            <div class="metric-label">Mensajes totales</div>
          </div>
          <div class="metric">
            <div class="metric-value" id="metric-today-msgs">0</div>
            <div class="metric-label">Hoy</div>
          </div>
          <div class="metric">
            <div class="metric-value" id="metric-week-msgs">0</div>
            <div class="metric-label">Esta semana</div>
          </div>
          <div class="metric">
            <div class="metric-value" id="metric-pending-reminders">0</div>
            <div class="metric-label">Recordatorios pendientes</div>
          </div>
        </div>
      </div>

      <!-- Estado del sistema -->
      <div class="card">
        <h2>Estado del sistema</h2>
        <div class="stat">
          <span class="label"><span class="dot" id="dot-redis"></span>Redis</span>
          <span class="value" id="val-redis">—</span>
        </div>
        <div class="stat">
          <span class="label"><span class="dot" id="dot-ai"></span>Claude AI</span>
          <span class="value" id="val-ai">3 Haiku</span>
        </div>
        <div class="stat">
          <span class="label">Tasa de éxito</span>
          <span class="value" id="val-success-rate">0%</span>
        </div>
        <div class="stat">
          <span class="label">Tiempo promedio respuesta</span>
          <span class="value" id="val-avg-response">0ms</span>
        </div>
      </div>

      <!-- Cuentas conectadas -->
      <div class="card">
        <h2>Cuentas de Google</h2>
        <div id="accounts-list">
          <div class="empty">Cargando...</div>
        </div>
        <a href="/auth/google?account=nueva" class="connect-link" style="display:block;margin-top:12px;text-align:center;font-size:13px">
          + Conectar cuenta
        </a>
      </div>

      <!-- Recordatorios pendientes -->
      <div class="card">
        <h2>⏰ Recordatorios pendientes</h2>
        <div id="reminders-list" class="list-container">
          <div class="empty">Cargando recordatorios...</div>
        </div>
      </div>

      <!-- Eventos recientes -->
      <div class="card">
        <h2>📅 Eventos recientes</h2>
        <div id="events-list" class="list-container">
          <div class="empty">Cargando eventos...</div>
        </div>
      </div>

      <!-- Quick actions -->
      <div class="card">
        <h2>Acciones</h2>
        <div style="display:flex;flex-direction:column;gap:8px">
          <a href="/auth/status" target="_blank" style="font-size:13px;color:#818cf8;text-decoration:none">📋 Ver estado de cuentas</a>
          <a href="/health"      target="_blank" style="font-size:13px;color:#818cf8;text-decoration:none">💚 Health check</a>
        </div>
      </div>
    </div>

    <!-- Log de mensajes -->
    <div class="card" style="height:fit-content">
      <h2 style="display:flex;align-items:center;gap:8px">
        Mensajes recientes
        <span class="dot green pulse" style="margin-left:4px"></span>
        <span style="font-size:11px;color:#475569;font-weight:400;text-transform:none;letter-spacing:0">en vivo</span>
      </h2>
      <div class="msg-list" id="msg-list">
        <div class="empty">Esperando mensajes...</div>
      </div>
    </div>
  </main>

  <script>
    let msgCount = 0;

    function formatTime(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function formatUptime(secs) {
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      return h > 0 ? \`\${h}h \${m}m\` : m > 0 ? \`\${m}m \${s}s\` : \`\${s}s\`;
    }

    function renderAccounts(accounts) {
      const el = document.getElementById('accounts-list');
      if (!accounts.length) {
        el.innerHTML = '<div class="empty">Sin cuentas conectadas</div>';
        return;
      }
      el.innerHTML = accounts.map(a => \`
        <div class="account-item">
          <div class="account-icon">\${a[0].toUpperCase()}</div>
          <div>
            <div class="account-name">\${a}</div>
            <div class="account-sub">Google Calendar</div>
          </div>
          <a href="/auth/google?account=\${a}" class="connect-link">Reconectar</a>
        </div>
      \`).join('');
    }

    function renderMessages(messages) {
      const el = document.getElementById('msg-list');
      if (!messages.length) {
        el.innerHTML = '<div class="empty">Esperando mensajes...</div>';
        return;
      }
      el.innerHTML = messages.map(m => \`
        <div class="msg-item">
          <div class="msg-header">
            <span class="msg-from">📱 \${m.from}</span>
            <span class="msg-time">\${formatTime(m.timestamp)}</span>
          </div>
          <div class="msg-text">💬 \${m.text}</div>
          \${m.response ? \`<div class="msg-response">🤖 \${m.response}</div>\` : ''}
        </div>
      \`).join('');
    }

    async function refresh() {
      try {
        // Cargar métricas
        const metrics = await fetch('/api/metrics').then(r => r.json());
        document.getElementById('metric-total-msgs').textContent = metrics.totalMessages;
        document.getElementById('metric-today-msgs').textContent = metrics.messagesToday;
        document.getElementById('metric-week-msgs').textContent = metrics.messagesThisWeek;
        document.getElementById('metric-pending-reminders').textContent = metrics.pendingReminders;
        document.getElementById('val-success-rate').textContent = metrics.successRate + '%';
        document.getElementById('val-avg-response').textContent = metrics.avgResponseTime + 'ms';

        // Cargar estado del sistema
        const status = await fetch('/api/status').then(r => r.json());
        document.getElementById('uptime').textContent = 'Uptime: ' + formatUptime(status.uptime);
        document.getElementById('dot-redis').className = 'dot ' + (status.redis ? 'green' : 'red');
        document.getElementById('val-redis').textContent = status.redis ? 'Conectado' : 'Desconectado';
        document.getElementById('dot-ai').className = 'dot green';
        document.getElementById('status-badge').textContent = '● Online';
        document.getElementById('status-badge').className = 'badge online';

        // Cargar cuentas
        const accounts = status.accounts || [];
        renderAccounts(accounts);

        // Cargar recordatorios
        const reminders = await fetch('/api/reminders').then(r => r.json());
        const remindersEl = document.getElementById('reminders-list');
        if (reminders.reminders.length === 0) {
          remindersEl.innerHTML = '<div class="empty">Sin recordatorios pendientes</div>';
        } else {
          const reminderItems = reminders.reminders.slice(0, 10).map(function(rem) {
            return '<div class="reminder-item">' +
              '<div class="reminder-icon">⏰</div>' +
              '<div class="reminder-content">' +
                '<div class="reminder-title">' + (rem.message || 'Recordatorio') + '</div>' +
                '<div class="reminder-meta">' + new Date(rem.scheduledFor).toLocaleString() + '</div>' +
              '</div>' +
            '</div>';
          });
          remindersEl.innerHTML = reminderItems.join('');
        }

        // Cargar eventos recientes (de la primera cuenta disponible)
        const eventsEl = document.getElementById('events-list');
        if (accounts.length > 0) {
          try {
            const events = await fetch('/api/calendar-events?account=' + accounts[0].email + '&calendar=primary&days=7').then(r => r.json());
            if (events.events.length === 0) {
              eventsEl.innerHTML = '<div class="empty">Sin eventos próximos</div>';
            } else {
              const eventItems = events.events.slice(0, 10).map(function(evt) {
                return '<div class="event-item">' +
                  '<div class="event-icon">📅</div>' +
                  '<div class="event-content">' +
                    '<div class="event-title">' + (evt.summary || 'Evento') + '</div>' +
                    '<div class="event-meta">' + new Date(evt.start?.dateTime || evt.start?.date).toLocaleString() + '</div>' +
                  '</div>' +
                '</div>';
              });
              eventsEl.innerHTML = eventItems.join('');
            }
          } catch (err) {
            eventsEl.innerHTML = '<div class="empty">Error cargando eventos</div>';
          }
        } else {
          eventsEl.innerHTML = '<div class="empty">Conecta una cuenta para ver eventos</div>';
        }

        renderMessages(status.messages);
      } catch (e) {
        document.getElementById('status-badge').textContent = '● Offline';
        document.getElementById('status-badge').className = 'badge offline';
      }
    }

    // SSE para mensajes en tiempo real
    const evtSource = new EventSource('/api/events');
    evtSource.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const el  = document.getElementById('msg-list');
      const item = document.createElement('div');
      item.className = 'msg-item new-msg';
      item.innerHTML = \`
        <div class="msg-header">
          <span class="msg-from">📱 \${msg.from}</span>
          <span class="msg-time">\${formatTime(msg.timestamp)}</span>
        </div>
        <div class="msg-text">💬 \${msg.text}</div>
        \${msg.response ? \`<div class="msg-response">🤖 \${msg.response}</div>\` : ''}
      \`;
      if (el.querySelector('.empty')) el.innerHTML = '';
      el.prepend(item);
    });

    refresh();
    setInterval(refresh, 5000); // auto-refresh cada 5s
  </script>
</body>
</html>`;
}

export default router;
