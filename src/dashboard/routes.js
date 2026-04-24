import { Router } from 'express';
import { listConnectedAccounts } from '../auth/google.js';
import { getMessageLog } from '../conversation/store.js';
import { getRedisClient } from '../redis/client.js';
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

// ─── API: estado del sistema ──────────────────────────────────────────────────
router.get('/api/status', async (req, res) => {
  try {
    const [accounts, messages, redis] = await Promise.all([
      listConnectedAccounts().catch(() => []),
      getMessageLog(20),
      getRedisClient().then(() => true).catch(() => false),
    ]);

    res.json({
      ok:       true,
      uptime:   Math.floor((Date.now() - startTime) / 1000),
      redis,
      accounts,
      messages,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

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
    .account-item { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #334155; }
    .account-item:last-child { border: none; }
    .account-icon { width: 32px; height: 32px; border-radius: 50%; background: #4f46e5; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: white; flex-shrink: 0; }
    .account-name { font-size: 14px; font-weight: 600; color: #f1f5f9; }
    .account-sub  { font-size: 12px; color: #64748b; }
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

      <!-- Estado del sistema -->
      <div class="card">
        <h2>Estado del sistema</h2>
        <div class="stat">
          <span class="label"><span class="dot" id="dot-redis"></span>Redis</span>
          <span class="value" id="val-redis">—</span>
        </div>
        <div class="stat">
          <span class="label"><span class="dot" id="dot-ai"></span>Gemini AI</span>
          <span class="value" id="val-ai">1.5 Flash</span>
        </div>
        <div class="stat">
          <span class="label">Mensajes procesados</span>
          <span class="value" id="val-msgs">0</span>
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
        const data = await fetch('/api/status').then(r => r.json());
        if (!data.ok) return;

        document.getElementById('uptime').textContent = 'Uptime: ' + formatUptime(data.uptime);
        document.getElementById('dot-redis').className  = 'dot ' + (data.redis ? 'green' : 'red');
        document.getElementById('val-redis').textContent = data.redis ? 'Conectado' : 'Desconectado';
        document.getElementById('dot-ai').className = 'dot green';
        document.getElementById('val-msgs').textContent = data.messages.length;
        msgCount = data.messages.length;

        renderAccounts(data.accounts);
        renderMessages(data.messages);
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
