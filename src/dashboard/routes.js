import { Router } from 'express';
import { listConnectedAccounts } from '../auth/google.js';
import { getMessageLog } from '../conversation/store.js';
import { getRedisClient } from '../redis/client.js';
import { getPendingReminders } from '../redis/reminders.js';
import { getTasksConfig, updateTask, getTaskLog } from '../redis/tasks.js';
import { listAllCalendars, getEvents } from '../calendar/client.js';
import { runMorningBriefing } from '../tasks/morning-briefing.js';
import { syncScheduler } from '../tasks/scheduler.js';
import { searchEmails, getUnreadCount, markAsRead } from '../gmail/client.js';
import { getTasks, completeTask, deleteTask } from '../tasks/client.js';

const router = Router();
const startTime = Date.now();

// ─── SSE broadcast ────────────────────────────────────────────────────────────
const sseClients = new Set();

export function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

router.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── API: métricas ────────────────────────────────────────────────────────────
router.get('/api/metrics', async (req, res) => {
  try {
    const accounts = await listConnectedAccounts();
    const [messages, reminders, calendars] = await Promise.all([
      getMessageLog(1000),
      getPendingReminders(),
      listAllCalendars().catch(() => []),
    ]);

    let unreadEmails = 0;
    try {
      const unreadResults = await Promise.all(
        accounts.map((a) => getUnreadCount(a).catch(() => ({ unreadCount: 0 }))),
      );
      unreadEmails = unreadResults.reduce((s, r) => s + (r.unreadCount || 0), 0);
    } catch { /* sin permisos gmail aún */ }

    const now = Date.now();
    const day  = new Date(now - 86400000);
    const week = new Date(now - 7 * 86400000);
    const month= new Date(now - 30 * 86400000);
    const success = messages.filter(m => m.response && !m.response.toLowerCase().includes('error')).length;
    res.json({
      totalMessages:     messages.length,
      messagesToday:     messages.filter(m => new Date(m.timestamp) >= day).length,
      messagesThisWeek:  messages.filter(m => new Date(m.timestamp) >= week).length,
      messagesThisMonth: messages.filter(m => new Date(m.timestamp) >= month).length,
      pendingReminders:  reminders.length,
      connectedCalendars: calendars.length,
      totalCalendars:    calendars.reduce((s, c) => s + (c.calendars?.length || 0), 0),
      successRate:       messages.length ? Math.round((success / messages.length) * 100) : 100,
      unreadEmails,
    });
  } catch {
    res.status(500).json({ error: 'Error obteniendo métricas' });
  }
});

// ─── API: estado ──────────────────────────────────────────────────────────────
router.get('/api/status', async (req, res) => {
  try {
    const [accounts, messages] = await Promise.all([listConnectedAccounts(), getMessageLog(30)]);
    let redisOk = true;
    try { await getRedisClient(); } catch { redisOk = false; }
    res.json({ uptime: Math.floor((Date.now() - startTime) / 1000), redis: redisOk, accounts, messages });
  } catch {
    res.status(500).json({ error: 'Error obteniendo estado' });
  }
});

// ─── API: calendario ──────────────────────────────────────────────────────────
router.get('/api/calendar-events', async (req, res) => {
  try {
    const { account, calendar } = req.query;
    let days = parseInt(req.query.days, 10);
    if (Number.isNaN(days) || days <= 0) days = 7;
    if (!account || !calendar) return res.status(400).json({ error: 'Se requieren account y calendar' });
    const start = new Date();
    const end   = new Date(start.getTime() + days * 86400000);
    const events = await getEvents(account, calendar, start.toISOString(), end.toISOString());
    res.json({ events });
  } catch (err) {
    res.status(err.message?.includes('no conectada') ? 400 : 500).json({ error: err.message });
  }
});

// ─── API: gmail unread ────────────────────────────────────────────────────────
router.get('/api/gmail/unread', async (req, res) => {
  try {
    const accounts = await listConnectedAccounts();
    const results = await Promise.all(
      accounts.map(async (account) => {
        try {
          const data = await getUnreadCount(account);
          return { account, ...data };
        } catch {
          return { account, unreadCount: 0, error: true };
        }
      }),
    );
    const total = results.reduce((s, r) => s + (r.unreadCount || 0), 0);
    res.json({ total, accounts: results });
  } catch {
    res.status(500).json({ error: 'Error obteniendo emails' });
  }
});

// ─── API: gmail emails ────────────────────────────────────────────────────────
router.get('/api/gmail/emails', async (req, res) => {
  try {
    const { account, query = 'in:inbox', max = '10' } = req.query;
    if (!account) return res.status(400).json({ error: 'Se requiere account' });
    const emails = await searchEmails(account, query, parseInt(max, 10));
    res.json({ emails });
  } catch (err) {
    res.status(err.message?.includes('no conectada') ? 400 : 500).json({ error: err.message });
  }
});

// ─── API: gmail mark read ─────────────────────────────────────────────────────
router.post('/api/gmail/mark-read', async (req, res) => {
  try {
    const { account, messageId } = req.body;
    if (!account || !messageId) return res.status(400).json({ error: 'Se requieren account y messageId' });
    await markAsRead(account, messageId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: gtasks ──────────────────────────────────────────────────────────────
router.get('/api/gtasks', async (req, res) => {
  try {
    const { account, taskListId = '@default' } = req.query;
    if (!account) return res.status(400).json({ error: 'Se requiere account' });
    const tasks = await getTasks(account, taskListId, false);
    res.json({ tasks });
  } catch (err) {
    res.status(err.message?.includes('no conectada') ? 400 : 500).json({ error: err.message });
  }
});

// ─── API: gtasks complete ─────────────────────────────────────────────────────
router.post('/api/gtasks/complete', async (req, res) => {
  try {
    const { account, taskId, taskListId = '@default' } = req.body;
    if (!account || !taskId) return res.status(400).json({ error: 'Se requieren account y taskId' });
    const result = await completeTask(account, taskListId, taskId);
    res.json({ ok: true, task: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: gtasks delete ───────────────────────────────────────────────────────
router.delete('/api/gtasks/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { account, taskListId = '@default' } = req.query;
    if (!account) return res.status(400).json({ error: 'Se requiere account' });
    await deleteTask(account, taskListId, taskId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: recordatorios ───────────────────────────────────────────────────────
router.get('/api/reminders', async (req, res) => {
  try {
    res.json({ reminders: await getPendingReminders() });
  } catch {
    res.status(500).json({ error: 'Error obteniendo recordatorios' });
  }
});

// ─── API: tareas programadas — lectura ────────────────────────────────────────
router.get('/api/tasks', async (req, res) => {
  try {
    const config = await getTasksConfig();
    const log    = await getTaskLog('morning_briefing');
    res.json({ tasks: config, logs: { morning_briefing: log } });
  } catch {
    res.status(500).json({ error: 'Error obteniendo tareas' });
  }
});

// ─── API: actualizar tarea ────────────────────────────────────────────────────
router.post('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['morning_briefing'];
    if (!allowed.includes(id)) return res.status(400).json({ error: 'Tarea desconocida' });

    // Validate phone if provided
    const updates = req.body;
    if (updates.phone !== undefined && updates.phone !== '' && !/^\d{7,20}$/.test(updates.phone)) {
      return res.status(400).json({ error: 'Número de teléfono inválido (solo dígitos, 7-20 chars)' });
    }

    const updated = await updateTask(id, updates);
    await syncScheduler();
    res.json({ ok: true, task: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: ejecutar tarea ahora ────────────────────────────────────────────────
router.post('/api/tasks/:id/run', async (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'morning_briefing') {
      const result = await runMorningBriefing();
      res.json(result);
    } else {
      res.status(400).json({ error: 'Tarea desconocida' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getDashboardHTML());
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Bot Nahuel — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0f1e;--surface:#111827;--surface2:#1f2937;--border:#1e3a5f;
  --text:#e2e8f0;--muted:#64748b;--accent:#3b82f6;--accent2:#8b5cf6;
  --green:#22c55e;--red:#ef4444;--yellow:#eab308;--orange:#f97316;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{color:#60a5fa}

/* ── Layout ── */
.shell{display:grid;grid-template-rows:56px 1fr;height:100vh}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 20px;gap:14px;position:sticky;top:0;z-index:100}
.topbar-logo{font-size:22px}
.topbar-title{font-size:15px;font-weight:700;color:#f1f5f9}
.topbar-badge{font-size:11px;padding:3px 9px;border-radius:20px;font-weight:600;margin-left:4px}
.badge-on{background:#14532d;color:#86efac}
.badge-off{background:#7f1d1d;color:#fca5a5}
.topbar-clock{margin-left:auto;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.content{display:grid;grid-template-columns:220px 1fr;overflow:hidden}

/* ── Sidebar ── */
.sidebar{background:var(--surface);border-right:1px solid var(--border);padding:16px 0;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 18px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;transition:all .15s;border-left:3px solid transparent}
.nav-item:hover{background:var(--surface2);color:var(--text)}
.nav-item.active{background:rgba(59,130,246,.1);color:var(--accent);border-left-color:var(--accent)}
.nav-icon{font-size:15px;width:20px;text-align:center}
.nav-section{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;padding:14px 18px 6px}

/* ── Main panel ── */
.panel{overflow-y:auto;padding:24px}
.tab-content{display:none}
.tab-content.active{display:block}

/* ── Cards ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.card-title{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:16px;display:flex;align-items:center;gap:6px}
.card-title span{color:var(--text);text-transform:none;font-size:14px;font-weight:600;letter-spacing:0}

/* ── Metric grid ── */
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:16px}
.metric{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:16px;text-align:center}
.metric-val{font-size:28px;font-weight:800;color:#f1f5f9;line-height:1}
.metric-lbl{font-size:11px;color:var(--muted);margin-top:6px;text-transform:uppercase;letter-spacing:.04em}

/* ── Status rows ── */
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid rgba(30,58,95,.5)}
.stat-row:last-child{border:none}
.stat-lbl{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:6px}
.stat-val{font-size:13px;font-weight:600;color:#f1f5f9}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
.dot-green{background:var(--green);box-shadow:0 0 6px var(--green)}
.dot-red{background:var(--red)}
.dot-yellow{background:var(--yellow)}
.dot-pulse{animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

/* ── Toggle switch ── */
.toggle-wrap{display:flex;align-items:center;gap:10px}
.toggle{position:relative;display:inline-block;width:46px;height:24px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0;position:absolute}
.slider{position:absolute;cursor:pointer;inset:0;background:#334155;border-radius:24px;transition:.3s}
.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.3s}
input:checked+.slider{background:var(--green)}
input:checked+.slider:before{transform:translateX(22px)}
.toggle-label{font-size:13px;font-weight:500;color:var(--text)}

/* ── Inputs & Buttons ── */
input[type=text],input[type=time],select{
  background:var(--surface2);border:1px solid var(--border);color:var(--text);
  padding:8px 12px;border-radius:8px;font-size:13px;outline:none;
  transition:border-color .15s;width:100%
}
input[type=text]:focus,input[type=time]:focus,select:focus{border-color:var(--accent)}
.field{margin-bottom:12px}
.field label{display:block;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
.btn-primary{background:var(--accent);color:white}
.btn-primary:hover{background:#2563eb}
.btn-success{background:#166534;color:#86efac;border:1px solid #22c55e}
.btn-success:hover{background:#14532d}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn-ghost:hover{background:var(--surface2);color:var(--text)}
.btn:disabled{opacity:.5;cursor:not-allowed}

/* ── Section toggles grid ── */
.sections-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-top:8px}
.section-card{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;display:flex;align-items:center;gap:10px;transition:border-color .2s}
.section-card.active{border-color:var(--accent)}
.section-card .section-icon{font-size:18px}
.section-card .section-name{font-size:12px;font-weight:600;color:var(--text)}

/* ── Task header ── */
.task-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.task-title{font-size:16px;font-weight:700;color:#f1f5f9;display:flex;align-items:center;gap:8px}
.task-status{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600}
.task-status.on{background:#14532d;color:#86efac}
.task-status.off{background:#292524;color:#a8a29e}
.task-last-run{font-size:11px;color:var(--muted);margin-top:8px}

/* ── Logs ── */
.log-list{max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-top:8px}
.log-item{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);padding:6px 10px;background:var(--surface2);border-radius:6px}
.log-item .log-icon{font-size:13px}

/* ── Messages ── */
.msg-list{display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 160px);overflow-y:auto}
.msg-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px}
.msg-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.msg-from{font-size:12px;font-weight:700;color:var(--accent)}
.msg-time{font-size:11px;color:var(--muted)}
.msg-body{font-size:13px;color:#cbd5e1;line-height:1.5;margin-bottom:6px}
.msg-reply{font-size:12px;color:var(--muted);padding-top:8px;border-top:1px solid var(--border);line-height:1.5}
.msg-new{animation:slideIn .3s ease}
@keyframes slideIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}

/* ── Reminders / Events ── */
.list-item{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(30,58,95,.4)}
.list-item:last-child{border:none}
.list-icon{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.li-blue{background:rgba(59,130,246,.15)}
.li-purple{background:rgba(139,92,246,.15)}
.li-green{background:rgba(34,197,94,.15)}
.list-content{flex:1;min-width:0}
.list-title{font-size:13px;font-weight:600;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list-meta{font-size:11px;color:var(--muted);margin-top:2px}
.empty{text-align:center;padding:28px 0;color:var(--muted);font-size:13px}

/* ── Alert/toast ── */
.toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;z-index:999;transform:translateY(80px);opacity:0;transition:all .3s}
.toast.show{transform:translateY(0);opacity:1}
.toast-ok{background:#166534;color:#86efac;border:1px solid var(--green)}
.toast-err{background:#7f1d1d;color:#fca5a5;border:1px solid var(--red)}

/* ── Grid helpers ── */
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.flex-row{display:flex;gap:10px;align-items:center}
.mt-8{margin-top:8px}
.mt-12{margin-top:12px}

/* ── Accounts ── */
.account-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(30,58,95,.4)}
.account-row:last-child{border:none}
.account-avatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:white;flex-shrink:0}
.account-name{font-size:13px;font-weight:600;color:#f1f5f9}
.account-sub{font-size:11px;color:var(--muted)}

/* ── Mobile menu ── */
.menu-btn{display:none;background:none;border:none;color:var(--text);cursor:pointer;padding:6px;line-height:0;border-radius:6px;flex-shrink:0;min-width:36px;min-height:36px;align-items:center;justify-content:center}
.menu-btn:hover{background:var(--surface2)}
.menu-btn svg{display:block;width:22px;height:22px;stroke:var(--text);stroke-width:2;stroke-linecap:round}
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:199}
.sidebar-overlay.open{display:block}
@media(max-width:768px){
  .content{grid-template-columns:1fr}
  .sidebar{display:none;position:fixed;top:56px;left:0;bottom:0;width:240px;z-index:200;overflow-y:auto}
  .sidebar.open{display:block}
  .menu-btn{display:flex}
  .topbar-clock{display:none}
  .grid-2{grid-template-columns:1fr}
  .grid-3{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="shell">

<!-- ── Topbar ── -->
<header class="topbar">
  <button class="menu-btn" onclick="toggleMenu()" aria-label="Menú">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="3" y1="6"  x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  </button>
  <span class="topbar-logo">🤖</span>
  <span class="topbar-title">Bot Nahuel</span>
  <span class="topbar-badge badge-on" id="status-badge">● Online</span>
  <span class="topbar-clock" id="clock">--:--:--</span>
</header>
<div class="sidebar-overlay" id="sidebar-overlay" onclick="closeMenu()"></div>

<div class="content">

<!-- ── Sidebar ── -->
<nav class="sidebar">
  <div class="nav-section">Principal</div>
  <div class="nav-item active" data-tab="overview">   <span class="nav-icon">📊</span> Dashboard</div>
  <div class="nav-item" data-tab="tasks">             <span class="nav-icon">⚙️</span> Tareas programadas</div>
  <div class="nav-item" data-tab="messages">          <span class="nav-icon">💬</span> Mensajes</div>
  <div class="nav-section">Google</div>
  <div class="nav-item" data-tab="calendar">          <span class="nav-icon">📅</span> Calendario</div>
  <div class="nav-item" data-tab="gmail">             <span class="nav-icon">📧</span> Gmail</div>
  <div class="nav-item" data-tab="gtasks">            <span class="nav-icon">✅</span> Google Tasks</div>
  <div class="nav-section">Sistema</div>
  <div class="nav-item" data-tab="system">            <span class="nav-icon">🔧</span> Sistema</div>
  <div class="nav-section">Acciones</div>
  <div style="padding:0 12px;display:flex;flex-direction:column;gap:6px">
    <a href="/auth/google?account=nueva" class="btn btn-ghost" style="justify-content:center;width:100%">+ Conectar cuenta</a>
    <a href="/health" target="_blank" class="btn btn-ghost" style="justify-content:center;width:100%">💚 Health</a>
  </div>
</nav>

<!-- ── Main panel ── -->
<main class="panel">

<!-- ════════════════════ TAB: OVERVIEW ════════════════════ -->
<div class="tab-content active" id="tab-overview">
  <div class="metrics" id="metrics-grid">
    <div class="metric"><div class="metric-val" id="m-today">0</div><div class="metric-lbl">Mensajes hoy</div></div>
    <div class="metric"><div class="metric-val" id="m-week">0</div><div class="metric-lbl">Esta semana</div></div>
    <div class="metric"><div class="metric-val" id="m-total">0</div><div class="metric-lbl">Total</div></div>
    <div class="metric"><div class="metric-val" id="m-reminders">0</div><div class="metric-lbl">Recordatorios</div></div>
    <div class="metric"><div class="metric-val" id="m-success">100%</div><div class="metric-lbl">Tasa de éxito</div></div>
    <div class="metric"><div class="metric-val" id="m-calendars">0</div><div class="metric-lbl">Calendarios</div></div>
    <div class="metric" style="cursor:pointer" onclick="goToTab('gmail')"><div class="metric-val" id="m-unread" style="color:var(--orange)">—</div><div class="metric-lbl">Emails sin leer</div></div>
    <div class="metric" style="cursor:pointer" onclick="goToTab('gtasks')"><div class="metric-val" id="m-tasks" style="color:var(--accent2)">—</div><div class="metric-lbl">Tareas pendientes</div></div>
  </div>

  <div class="grid-2">
    <!-- Resumen matutino preview -->
    <div class="card">
      <div class="card-title">🌅 <span>Resumen Matutino</span></div>
      <div id="overview-task-status"></div>
      <div class="flex-row mt-12">
        <button class="btn btn-primary" onclick="runTaskNow('morning_briefing')" id="btn-run-briefing">
          ▶ Enviar ahora
        </button>
        <button class="btn btn-ghost" onclick="goToTab('tasks')">Configurar →</button>
      </div>
    </div>

    <!-- Próximas reuniones -->
    <div class="card">
      <div class="card-title">📅 <span>Próximas reuniones</span></div>
      <div id="overview-events" class="list-container">
        <div class="empty">Cargando...</div>
      </div>
    </div>
  </div>

  <!-- Recent messages preview -->
  <div class="card">
    <div class="card-title" style="justify-content:space-between">
      <span style="display:flex;align-items:center;gap:6px">💬 <span>Mensajes recientes</span></span>
      <span style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--green)">
        <span class="dot dot-green dot-pulse"></span> en vivo
      </span>
    </div>
    <div id="overview-msgs" class="msg-list" style="max-height:320px"></div>
  </div>
</div>

<!-- ════════════════════ TAB: TAREAS ════════════════════ -->
<div class="tab-content" id="tab-tasks">
  <h2 style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:20px">⚙️ Tareas Programadas</h2>

  <!-- Morning Briefing -->
  <div class="card">
    <div class="task-header">
      <div class="task-title">🌅 Resumen Matutino</div>
      <div>
        <span class="task-status off" id="mb-status-badge">Desactivado</span>
      </div>
    </div>

    <div class="stat-row">
      <span class="stat-lbl">Estado</span>
      <label class="toggle">
        <input type="checkbox" id="mb-enabled" onchange="saveMorningBriefing()">
        <span class="slider"></span>
      </label>
    </div>

    <div class="grid-2 mt-12">
      <div class="field">
        <label>Hora de envío</label>
        <input type="time" id="mb-time" value="07:00" onchange="saveMorningBriefing()">
      </div>
      <div class="field">
        <label>Número WhatsApp destino</label>
        <input type="text" id="mb-phone" placeholder="549XXXXXXXXXX (solo dígitos)" oninput="debounceSave()">
      </div>
    </div>

    <div class="field">
      <label>Cuenta de Google Calendar</label>
      <select id="mb-calendar-account" onchange="saveMorningBriefing()">
        <option value="">— Sin calendario —</option>
      </select>
    </div>

    <div class="field">
      <label>Secciones incluidas</label>
      <div class="sections-grid">
        <div class="section-card" id="sec-weather">
          <span class="section-icon">🌤️</span>
          <div><div class="section-name">Clima</div>
          <label class="toggle" style="width:36px;height:20px;margin-top:4px">
            <input type="checkbox" id="sec-weather-chk" checked onchange="saveSections()">
            <span class="slider" style="border-radius:20px"></span>
          </label></div>
        </div>
        <div class="section-card" id="sec-belgrano">
          <span class="section-icon">⚽</span>
          <div><div class="section-name">Belgrano</div>
          <label class="toggle" style="width:36px;height:20px;margin-top:4px">
            <input type="checkbox" id="sec-belgrano-chk" checked onchange="saveSections()">
            <span class="slider" style="border-radius:20px"></span>
          </label></div>
        </div>
        <div class="section-card" id="sec-cordoba">
          <span class="section-icon">🏙️</span>
          <div><div class="section-name">Noticias Córdoba</div>
          <label class="toggle" style="width:36px;height:20px;margin-top:4px">
            <input type="checkbox" id="sec-cordoba-chk" checked onchange="saveSections()">
            <span class="slider" style="border-radius:20px"></span>
          </label></div>
        </div>
        <div class="section-card" id="sec-argentina">
          <span class="section-icon">🇦🇷</span>
          <div><div class="section-name">Noticias Argentina</div>
          <label class="toggle" style="width:36px;height:20px;margin-top:4px">
            <input type="checkbox" id="sec-argentina-chk" checked onchange="saveSections()">
            <span class="slider" style="border-radius:20px"></span>
          </label></div>
        </div>
        <div class="section-card" id="sec-calendar">
          <span class="section-icon">📅</span>
          <div><div class="section-name">Reuniones del día</div>
          <label class="toggle" style="width:36px;height:20px;margin-top:4px">
            <input type="checkbox" id="sec-calendar-chk" checked onchange="saveSections()">
            <span class="slider" style="border-radius:20px"></span>
          </label></div>
        </div>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="runTaskNow('morning_briefing')" id="btn-run-mb">
        ▶ Enviar ahora (prueba)
      </button>
      <button class="btn btn-ghost" onclick="loadTasks()">↻ Recargar</button>
    </div>

    <div class="task-last-run" id="mb-last-run"></div>

    <!-- Log de ejecuciones -->
    <div style="margin-top:16px">
      <div class="card-title" style="margin-bottom:8px">📋 <span>Últimas ejecuciones</span></div>
      <div class="log-list" id="mb-log"></div>
    </div>
  </div>
</div>

<!-- ════════════════════ TAB: MENSAJES ════════════════════ -->
<div class="tab-content" id="tab-messages">
  <h2 style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:20px;display:flex;align-items:center;gap:10px">
    💬 Mensajes en tiempo real
    <span style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:400;color:var(--green)">
      <span class="dot dot-green dot-pulse"></span> en vivo
    </span>
  </h2>
  <div class="msg-list" id="all-msgs">
    <div class="empty">Esperando mensajes...</div>
  </div>
</div>

<!-- ════════════════════ TAB: CALENDARIO ════════════════════ -->
<div class="tab-content" id="tab-calendar">
  <h2 style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:16px">📅 Calendario</h2>

  <!-- Filtros -->
  <div class="card" style="margin-bottom:16px">
    <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
      <div class="field" style="margin:0;flex:1;min-width:140px">
        <label>Cuenta</label>
        <select id="cal-account-sel" onchange="loadCalendar()">
          <option value="">Cargando...</option>
        </select>
      </div>
      <div class="field" style="margin:0;flex:1;min-width:140px">
        <label>Período</label>
        <select id="cal-days-sel" onchange="loadCalendar()">
          <option value="1">Hoy</option>
          <option value="3">Próximos 3 días</option>
          <option value="7" selected>Próximos 7 días</option>
          <option value="14">Próximas 2 semanas</option>
          <option value="30">Próximo mes</option>
          <option value="90">Próximos 3 meses</option>
        </select>
      </div>
      <button class="btn btn-ghost" style="margin-bottom:0" onclick="loadCalendar()">↻ Actualizar</button>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-title">📅 <span id="cal-events-title">Próximos eventos</span></div>
      <div id="cal-events-list"><div class="empty">Cargando...</div></div>
    </div>
    <div class="card">
      <div class="card-title">⏰ <span>Recordatorios pendientes</span></div>
      <div id="reminders-list"><div class="empty">Cargando...</div></div>
    </div>
  </div>
</div>

<!-- ════════════════════ TAB: GMAIL ════════════════════ -->
<div class="tab-content" id="tab-gmail">
  <h2 style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:16px">📧 Gmail</h2>

  <!-- Filtros -->
  <div class="card" style="margin-bottom:16px">
    <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
      <div class="field" style="margin:0;flex:1;min-width:140px">
        <label>Cuenta</label>
        <select id="gmail-account-sel" onchange="loadGmail()">
          <option value="">Cargando...</option>
        </select>
      </div>
      <div class="field" style="margin:0;flex:2;min-width:200px">
        <label>Búsqueda (Gmail query)</label>
        <input type="text" id="gmail-query" placeholder="is:unread · from:juan@... · subject:..." value="in:inbox">
      </div>
      <button class="btn btn-primary" style="margin-bottom:0" onclick="loadGmail()">🔍 Buscar</button>
    </div>
  </div>

  <!-- Resumen unread por cuenta -->
  <div id="gmail-unread-summary" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px"></div>

  <!-- Lista de emails -->
  <div class="card">
    <div class="card-title" style="justify-content:space-between">
      <span style="display:flex;align-items:center;gap:6px">📧 <span id="gmail-list-title">Emails</span></span>
      <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="loadGmail()">↻</button>
    </div>
    <div id="gmail-list"><div class="empty">Cargando...</div></div>
  </div>
</div>

<!-- ════════════════════ TAB: GOOGLE TASKS ════════════════════ -->
<div class="tab-content" id="tab-gtasks">
  <h2 style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:16px">✅ Google Tasks</h2>

  <!-- Filtros -->
  <div class="card" style="margin-bottom:16px">
    <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
      <div class="field" style="margin:0;flex:1;min-width:140px">
        <label>Cuenta</label>
        <select id="gtasks-account-sel" onchange="loadGTasks()">
          <option value="">Cargando...</option>
        </select>
      </div>
      <button class="btn btn-ghost" style="margin-bottom:0" onclick="loadGTasks()">↻ Actualizar</button>
    </div>
  </div>

  <!-- Lista de tareas -->
  <div class="card">
    <div class="card-title" style="justify-content:space-between">
      <span style="display:flex;align-items:center;gap:6px">✅ <span id="gtasks-count">Tareas pendientes</span></span>
    </div>
    <div id="gtasks-list"><div class="empty">Cargando...</div></div>
  </div>
</div>

<!-- ════════════════════ TAB: SISTEMA ════════════════════ -->
<div class="tab-content" id="tab-system">
  <h2 style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:20px">🔧 Sistema</h2>
  <div class="grid-2">
    <div class="card">
      <div class="card-title">💡 <span>Estado del sistema</span></div>
      <div class="stat-row"><span class="stat-lbl"><span class="dot" id="dot-redis"></span> Redis</span><span class="stat-val" id="val-redis">—</span></div>
      <div class="stat-row"><span class="stat-lbl"><span class="dot dot-green"></span> Claude AI</span><span class="stat-val">Haiku via OpenRouter</span></div>
      <div class="stat-row"><span class="stat-lbl">Uptime</span><span class="stat-val" id="val-uptime">—</span></div>
      <div class="stat-row"><span class="stat-lbl">Tasa de éxito</span><span class="stat-val" id="val-success">—</span></div>
    </div>
    <div class="card">
      <div class="card-title">📱 <span>Cuentas de Google</span></div>
      <div id="accounts-list"><div class="empty">Cargando...</div></div>
      <a href="/auth/google?account=nueva" class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:12px">+ Conectar nueva cuenta</a>
    </div>
  </div>
</div>

</main>
</div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
// ── Utils ──────────────────────────────────────────────────────────────────
function fmt(iso) {
  const d = new Date(iso);
  return d.toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
function fmtUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h > 0 ? h+'h '+m+'m' : m > 0 ? m+'m '+sec+'s' : sec+'s';
}
// fmtEvent: handles both "2026-04-23T10:00:00-03:00" (timed) and "2026-04-23" (all-day)
function fmtEvent(dt) {
  if (!dt) return 'Sin fecha';
  if (dt.includes('T')) {
    const d = new Date(dt);
    return d.toLocaleString('es-AR', { weekday:'short', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
  }
  const [y, mo, d] = dt.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('es-AR', { weekday:'short', day:'2-digit', month:'2-digit' }) + ' · Todo el día';
}
function showToast(msg, ok = true) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}
function msgCard(m, prepend = false) {
  const d = document.createElement('div');
  d.className = 'msg-card' + (prepend ? ' msg-new' : '');
  d.innerHTML =
    '<div class="msg-head">' +
      '<span class="msg-from">📱 ' + (m.from||'?') + '</span>' +
      '<span class="msg-time">' + fmtTime(m.timestamp) + '</span>' +
    '</div>' +
    '<div class="msg-body">💬 ' + (m.text||'').slice(0, 300) + '</div>' +
    (m.response ? '<div class="msg-reply">🤖 ' + (m.response||'').slice(0, 400) + '</div>' : '');
  return d;
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function goToTab(id) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + id)?.classList.add('active');
  document.querySelector('[data-tab=' + id + ']')?.classList.add('active');
  if (id === 'calendar') loadCalendar();
  if (id === 'gmail') loadGmail();
  if (id === 'gtasks') loadGTasks();
}
document.querySelectorAll('.nav-item[data-tab]').forEach(el => {
  el.addEventListener('click', () => { goToTab(el.dataset.tab); closeMenu(); });
});

// ── Mobile menu ───────────────────────────────────────────────────────────
function toggleMenu() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const open = sidebar.classList.toggle('open');
  overlay.classList.toggle('open', open);
}
function closeMenu() {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ── Clock ──────────────────────────────────────────────────────────────────
setInterval(() => {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('es-AR', { hour12: false });
}, 1000);

// ── SSE ───────────────────────────────────────────────────────────────────
const sse = new EventSource('/api/events');
sse.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  ['all-msgs', 'overview-msgs'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.querySelector('.empty')) el.innerHTML = '';
    el.prepend(msgCard(m, true));
    while (el.children.length > 50) el.lastChild.remove();
  });
});

// ── Metrics ───────────────────────────────────────────────────────────────
async function loadMetrics() {
  try {
    const d = await fetch('/api/metrics').then(r => r.json());
    document.getElementById('m-today').textContent     = d.messagesToday;
    document.getElementById('m-week').textContent      = d.messagesThisWeek;
    document.getElementById('m-total').textContent     = d.totalMessages;
    document.getElementById('m-reminders').textContent = d.pendingReminders;
    document.getElementById('m-success').textContent   = d.successRate + '%';
    document.getElementById('m-calendars').textContent = d.totalCalendars;
    document.getElementById('val-success').textContent = d.successRate + '%';
    if (d.unreadEmails !== undefined) document.getElementById('m-unread').textContent = d.unreadEmails;
  } catch {}
}

async function loadStatus() {
  try {
    const d = await fetch('/api/status').then(r => r.json());
    document.getElementById('val-uptime').textContent = fmtUptime(d.uptime);
    const redisOk = d.redis;
    document.getElementById('dot-redis').className = 'dot ' + (redisOk ? 'dot-green' : 'dot-red');
    document.getElementById('val-redis').textContent = redisOk ? 'Conectado' : 'Desconectado';
    document.getElementById('status-badge').textContent = '● Online';
    document.getElementById('status-badge').className = 'topbar-badge badge-on';

    // Accounts
    const al = document.getElementById('accounts-list');
    if (!d.accounts?.length) {
      al.innerHTML = '<div class="empty">Sin cuentas conectadas</div>';
    } else {
      al.innerHTML = d.accounts.map(a =>
        '<div class="account-row">' +
          '<div class="account-avatar">' + a[0].toUpperCase() + '</div>' +
          '<div><div class="account-name">' + a + '</div><div class="account-sub">Calendar · Gmail · Tasks</div></div>' +
          '<a href="/auth/google?account=' + a + '" style="margin-left:auto;font-size:11px;color:var(--accent)">Reconectar</a>' +
        '</div>'
      ).join('');
    }

    // Populate task config calendar account dropdown
    const sel = document.getElementById('mb-calendar-account');
    const curVal = sel.value;
    sel.innerHTML = '<option value="">— Sin calendario —</option>' +
      (d.accounts||[]).map(a => '<option value="' + a + '">' + a + '</option>').join('');
    if (curVal) sel.value = curVal;

    // Populate calendar/gmail/gtasks account selectors
    const accs = d.accounts || [];
    const populateSel = (id) => {
      const sel = document.getElementById(id);
      if (!sel || !accs.length) return;
      const cur = sel.value;
      sel.innerHTML = accs.map(a => '<option value="' + a + '">' + a + '</option>').join('');
      if (cur && accs.includes(cur)) sel.value = cur;
    };
    _calAccounts = accs;
    _gmailAccounts = accs;
    _gtasksAccounts = accs;
    populateSel('cal-account-sel');
    populateSel('gmail-account-sel');
    populateSel('gtasks-account-sel');

    // Messages — populate both overview preview and full messages tab
    if (d.messages?.length) {
      const ovEl = document.getElementById('overview-msgs');
      if (ovEl) { ovEl.innerHTML = ''; d.messages.slice(0, 5).forEach(m => ovEl.appendChild(msgCard(m))); }
      const allEl = document.getElementById('all-msgs');
      if (allEl && allEl.querySelector('.empty')) {
        allEl.innerHTML = '';
        d.messages.slice(0, 50).forEach(m => allEl.appendChild(msgCard(m)));
      }
    }
  } catch {
    document.getElementById('status-badge').textContent = '● Offline';
    document.getElementById('status-badge').className = 'topbar-badge badge-off';
  }
}

// ── Calendar & Reminders ──────────────────────────────────────────────────
let _calAccounts = [];

async function loadCalendar() {
  // Fetch accounts if not yet loaded (populate selector)
  if (!_calAccounts.length) {
    try {
      const status = await fetch('/api/status').then(r => r.json());
      _calAccounts = status.accounts || [];
      const sel = document.getElementById('cal-account-sel');
      if (sel) {
        sel.innerHTML = _calAccounts.length
          ? _calAccounts.map(a => '<option value="' + a + '">' + a + '</option>').join('')
          : '<option value="">Sin cuentas conectadas</option>';
      }
    } catch {}
  }

  const accountSel = document.getElementById('cal-account-sel');
  const daysSel    = document.getElementById('cal-days-sel');
  const account    = accountSel?.value || _calAccounts[0] || '';
  const days       = parseInt(daysSel?.value || '7', 10);
  const evEl       = document.getElementById('cal-events-list');
  const ovEl       = document.getElementById('overview-events');
  const titleEl    = document.getElementById('cal-events-title');

  // Update title
  const periodLabel = daysSel?.selectedOptions[0]?.text || (days + ' días');
  if (titleEl) titleEl.textContent = periodLabel;

  if (!account) {
    if (evEl) evEl.innerHTML = '<div class="empty">Conecta una cuenta de Google para ver eventos</div>';
    if (ovEl) ovEl.innerHTML = '<div class="empty">Sin cuentas conectadas</div>';
  } else {
    try {
      if (evEl) evEl.innerHTML = '<div class="empty">Cargando...</div>';
      const data = await fetch('/api/calendar-events?account=' + encodeURIComponent(account) + '&calendar=primary&days=' + days).then(r => r.json());
      const events = data.events || [];

      const renderEvents = (el, max) => {
        if (!el) return;
        if (!events.length) { el.innerHTML = '<div class="empty">Sin eventos en este período</div>'; return; }
        el.innerHTML = events.slice(0, max).map(e =>
          '<div class="list-item">' +
            '<div class="list-icon li-blue">📅</div>' +
            '<div class="list-content">' +
              '<div class="list-title">' + (e.summary || 'Sin título') + '</div>' +
              '<div class="list-meta">' + fmtEvent(e.start) + '</div>' +
            '</div>' +
          '</div>'
        ).join('');
      };

      renderEvents(evEl, 50);
      renderEvents(ovEl, 4);
    } catch {
      if (evEl) evEl.innerHTML = '<div class="empty">Error cargando eventos</div>';
    }
  }

  // Reminders
  try {
    const { reminders } = await fetch('/api/reminders').then(r => r.json());
    const el = document.getElementById('reminders-list');
    if (!el) return;
    if (!reminders.length) { el.innerHTML = '<div class="empty">Sin recordatorios pendientes</div>'; return; }
    el.innerHTML = reminders.slice(0, 10).map(r =>
      '<div class="list-item">' +
        '<div class="list-icon li-purple">⏰</div>' +
        '<div class="list-content">' +
          '<div class="list-title">' + (r.message || 'Recordatorio') + '</div>' +
          '<div class="list-meta">' + fmtEvent(r.reminderTime) + '</div>' +
        '</div>' +
      '</div>'
    ).join('');
  } catch {}
}

// ── Tasks ─────────────────────────────────────────────────────────────────
async function loadTasks() {
  try {
    const { tasks, logs } = await fetch('/api/tasks').then(r => r.json());
    const mb = tasks?.morning_briefing;
    if (!mb) return;

    document.getElementById('mb-enabled').checked = !!mb.enabled;
    document.getElementById('mb-time').value = mb.time || '07:00';
    document.getElementById('mb-phone').value = mb.phone || '';
    if (mb.calendarAccount) document.getElementById('mb-calendar-account').value = mb.calendarAccount;

    // Sections
    const sec = mb.sections || {};
    document.getElementById('sec-weather-chk').checked  = sec.weather !== false;
    document.getElementById('sec-belgrano-chk').checked = sec.news_belgrano !== false;
    document.getElementById('sec-cordoba-chk').checked  = sec.news_cordoba !== false;
    document.getElementById('sec-argentina-chk').checked= sec.news_argentina !== false;
    document.getElementById('sec-calendar-chk').checked = sec.calendar !== false;
    updateSectionCards();

    // Status badge
    const badge = document.getElementById('mb-status-badge');
    badge.textContent = mb.enabled ? 'Activo — ' + mb.time : 'Desactivado';
    badge.className = 'task-status ' + (mb.enabled ? 'on' : 'off');

    // Last run
    const lr = document.getElementById('mb-last-run');
    if (mb.lastRun) {
      const icon = mb.lastStatus === 'ok' ? '✅' : '❌';
      lr.textContent = icon + ' Último envío: ' + fmt(mb.lastRun) + (mb.lastError ? ' — ' + mb.lastError : '');
    } else {
      lr.textContent = 'Nunca ejecutado.';
    }

    // Overview card
    const ovCard = document.getElementById('overview-task-status');
    if (mb.enabled) {
      ovCard.innerHTML = '<div class="stat-row"><span class="stat-lbl">Horario</span><span class="stat-val">' + mb.time + ' todos los días</span></div>' +
        (mb.lastRun ? '<div class="stat-row"><span class="stat-lbl">Último envío</span><span class="stat-val">' + fmt(mb.lastRun) + '</span></div>' : '');
    } else {
      ovCard.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Desactivado. Ir a <strong>Tareas programadas</strong> para configurar.</div>';
    }

    // Log
    const logEl = document.getElementById('mb-log');
    const logItems = logs?.morning_briefing || [];
    if (!logItems.length) {
      logEl.innerHTML = '<div class="empty">Sin ejecuciones registradas</div>';
    } else {
      logEl.innerHTML = logItems.map(l =>
        '<div class="log-item">' +
          '<span class="log-icon">' + (l.status === 'ok' ? '✅' : '❌') + '</span>' +
          '<span>' + fmt(l.ts) + '</span>' +
          (l.error ? '<span style="color:var(--red)">— ' + l.error + '</span>' : '<span style="color:var(--muted)">— ok</span>') +
        '</div>'
      ).join('');
    }
  } catch (e) {
    console.error('Error cargando tareas:', e);
  }
}

function updateSectionCards() {
  const map = {
    'sec-weather': 'sec-weather-chk',
    'sec-belgrano': 'sec-belgrano-chk',
    'sec-cordoba': 'sec-cordoba-chk',
    'sec-argentina': 'sec-argentina-chk',
    'sec-calendar': 'sec-calendar-chk',
  };
  Object.entries(map).forEach(([cardId, chkId]) => {
    const checked = document.getElementById(chkId)?.checked;
    document.getElementById(cardId)?.classList.toggle('active', !!checked);
  });
}

async function saveMorningBriefing() {
  const phone = document.getElementById('mb-phone').value.trim();
  const payload = {
    enabled:  document.getElementById('mb-enabled').checked,
    time:     document.getElementById('mb-time').value,
    phone,
    calendarAccount: document.getElementById('mb-calendar-account').value,
  };
  try {
    const r = await fetch('/api/tasks/morning_briefing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (r.error) { showToast('Error: ' + r.error, false); return; }
    showToast('✅ Configuración guardada');
    loadTasks();
  } catch { showToast('Error guardando configuración', false); }
}

function saveSections() {
  updateSectionCards();
  const payload = {
    sections: {
      weather:       document.getElementById('sec-weather-chk').checked,
      news_belgrano: document.getElementById('sec-belgrano-chk').checked,
      news_cordoba:  document.getElementById('sec-cordoba-chk').checked,
      news_argentina:document.getElementById('sec-argentina-chk').checked,
      calendar:      document.getElementById('sec-calendar-chk').checked,
    },
  };
  fetch('/api/tasks/morning_briefing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json()).then(r => {
    if (r.error) showToast('Error: ' + r.error, false);
    else showToast('✅ Secciones guardadas');
  }).catch(() => showToast('Error guardando secciones', false));
}

// Debounced save for phone input
let saveTimer;
function debounceSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveMorningBriefing, 800);
}

async function runTaskNow(id) {
  const btn = document.getElementById('btn-run-' + (id === 'morning_briefing' ? 'mb' : id));
  const btn2 = document.getElementById('btn-run-briefing');
  [btn, btn2].forEach(b => { if (b) { b.disabled = true; b.textContent = '⏳ Enviando...'; } });
  try {
    const r = await fetch('/api/tasks/' + id + '/run', { method: 'POST' }).then(r => r.json());
    if (r.success) showToast('✅ Resumen enviado correctamente');
    else showToast('❌ Error: ' + (r.error || 'desconocido'), false);
    loadTasks();
  } catch { showToast('Error de conexión', false); }
  finally {
    [btn, btn2].forEach(b => { if (b) { b.disabled = false; b.textContent = b.id === 'btn-run-briefing' ? '▶ Enviar ahora' : '▶ Enviar ahora (prueba)'; } });
  }
}

// ── Gmail ─────────────────────────────────────────────────────────────────
let _gmailAccounts = [];

async function loadGmail() {
  const sel      = document.getElementById('gmail-account-sel');
  const queryEl  = document.getElementById('gmail-query');
  const listEl   = document.getElementById('gmail-list');
  const titleEl  = document.getElementById('gmail-list-title');
  const summaryEl= document.getElementById('gmail-unread-summary');

  const account = sel?.value || _gmailAccounts[0] || '';
  const query   = queryEl?.value || 'in:inbox';

  if (!account) {
    if (listEl) listEl.innerHTML = '<div class="empty">Conectá una cuenta de Google primero</div>';
    return;
  }

  if (listEl) listEl.innerHTML = '<div class="empty">Cargando...</div>';

  // Resumen de no leídos por cuenta
  try {
    const { accounts: unreadAccs } = await fetch('/api/gmail/unread').then(r => r.json());
    if (summaryEl) {
      summaryEl.innerHTML = (unreadAccs || []).map(a =>
        '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:18px">📧</span>' +
          '<div><div style="font-size:13px;font-weight:600;color:#f1f5f9">' + a.account + '</div>' +
          '<div style="font-size:12px;color:' + (a.unreadCount > 0 ? 'var(--orange)' : 'var(--muted)') + '">' +
            (a.error ? 'Sin permiso' : a.unreadCount + ' sin leer') +
          '</div></div>' +
        '</div>'
      ).join('');
    }
  } catch {}

  // Emails
  try {
    const data = await fetch('/api/gmail/emails?account=' + encodeURIComponent(account) + '&query=' + encodeURIComponent(query) + '&max=15').then(r => r.json());
    if (data.error) { listEl.innerHTML = '<div class="empty">Error: ' + data.error + '</div>'; return; }
    const emails = data.emails || [];
    if (titleEl) titleEl.textContent = emails.length + ' email' + (emails.length !== 1 ? 's' : '');
    if (!emails.length) { listEl.innerHTML = '<div class="empty">Sin resultados para esa búsqueda</div>'; return; }

    listEl.innerHTML = emails.map(e =>
      '<div style="display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid rgba(30,58,95,.4)">' +
        '<div style="width:34px;height:34px;border-radius:50%;background:' + (e.isUnread ? 'rgba(249,115,22,.15)' : 'rgba(30,58,95,.3)') + ';display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">' +
          (e.isUnread ? '📬' : '📭') +
        '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
            '<span style="font-size:13px;font-weight:' + (e.isUnread ? '700' : '500') + ';color:' + (e.isUnread ? '#f1f5f9' : 'var(--muted)') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%">' + esc(e.subject || '(sin asunto)') + '</span>' +
            '<span style="font-size:11px;color:var(--muted);flex-shrink:0">' + esc(e.date?.slice(0, 11) || '') + '</span>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--accent);margin-top:2px">' + esc(e.from?.replace(/<.*>/, '').trim() || '') + '</div>' +
          '<div style="font-size:12px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(e.snippet || '') + '</div>' +
        '</div>' +
        (e.isUnread
          ? '<button onclick="markEmailRead(' + JSON.stringify(account) + ',' + JSON.stringify(e.id) + ',this)" style="flex-shrink:0;padding:4px 10px;font-size:11px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;cursor:pointer">✓ Leído</button>'
          : '') +
      '</div>'
    ).join('');
  } catch (err) {
    if (listEl) listEl.innerHTML = '<div class="empty">Error cargando emails</div>';
  }
}

async function markEmailRead(account, messageId, btn) {
  btn.disabled = true; btn.textContent = '...';
  try {
    await fetch('/api/gmail/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, messageId }),
    });
    btn.closest('div[style]').style.opacity = '.5';
    btn.remove();
    showToast('✅ Marcado como leído');
    loadMetrics();
  } catch { showToast('Error', false); btn.disabled = false; btn.textContent = '✓ Leído'; }
}

// ── Google Tasks ──────────────────────────────────────────────────────────
let _gtasksAccounts = [];

async function loadGTasks() {
  const sel     = document.getElementById('gtasks-account-sel');
  const listEl  = document.getElementById('gtasks-list');
  const countEl = document.getElementById('gtasks-count');
  const account = sel?.value || _gtasksAccounts[0] || '';

  if (!account) {
    if (listEl) listEl.innerHTML = '<div class="empty">Conectá una cuenta de Google primero</div>';
    return;
  }
  if (listEl) listEl.innerHTML = '<div class="empty">Cargando...</div>';

  try {
    const data = await fetch('/api/gtasks?account=' + encodeURIComponent(account)).then(r => r.json());
    if (data.error) { listEl.innerHTML = '<div class="empty">Error: ' + data.error + '</div>'; return; }
    const tasks = data.tasks || [];
    if (countEl) countEl.textContent = tasks.length + ' tarea' + (tasks.length !== 1 ? 's' : '') + ' pendiente' + (tasks.length !== 1 ? 's' : '');

    // Update metric
    const mEl = document.getElementById('m-tasks');
    if (mEl) mEl.textContent = tasks.length;

    if (!tasks.length) { listEl.innerHTML = '<div class="empty">¡Sin tareas pendientes! 🎉</div>'; return; }

    listEl.innerHTML = tasks.map(t => {
      const isOverdue = t.due && new Date(t.due) < new Date();
      return '<div id="gtask-' + esc(t.id) + '" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid rgba(30,58,95,.4)">' +
        '<button onclick="completeGTask(' + JSON.stringify(account) + ',' + JSON.stringify(t.id) + ',this)" ' +
          'style="width:22px;height:22px;border-radius:50%;border:2px solid var(--accent2);background:transparent;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:transparent" ' +
          'title="Marcar como completada">✓</button>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:13px;font-weight:600;color:#f1f5f9">' + esc(t.title) + '</div>' +
          (t.notes ? '<div style="font-size:12px;color:var(--muted);margin-top:2px">' + esc(t.notes.slice(0, 100)) + '</div>' : '') +
          (t.due ? '<div style="font-size:11px;color:' + (isOverdue ? 'var(--red)' : 'var(--muted)') + ';margin-top:3px">' +
            (isOverdue ? '⚠ Vencida: ' : '📅 Vence: ') + new Date(t.due).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' }) +
          '</div>' : '') +
        '</div>' +
        '<button onclick="deleteGTask(' + JSON.stringify(account) + ',' + JSON.stringify(t.id) + ',this)" ' +
          'style="padding:4px 10px;font-size:11px;background:transparent;border:1px solid rgba(239,68,68,.4);color:var(--red);border-radius:6px;cursor:pointer;flex-shrink:0">🗑</button>' +
      '</div>';
    }).join('');
  } catch {
    if (listEl) listEl.innerHTML = '<div class="empty">Error cargando tareas</div>';
  }
}

async function completeGTask(account, taskId, btn) {
  btn.style.background = 'var(--accent2)'; btn.style.color = 'white'; btn.disabled = true;
  try {
    await fetch('/api/gtasks/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, taskId }),
    });
    document.getElementById('gtask-' + taskId)?.remove();
    showToast('✅ Tarea completada');
    loadGTasks();
  } catch { showToast('Error', false); btn.style.background = 'transparent'; btn.style.color = 'transparent'; btn.disabled = false; }
}

async function deleteGTask(account, taskId, btn) {
  if (!confirm('¿Eliminar esta tarea?')) return;
  btn.disabled = true;
  try {
    await fetch('/api/gtasks/' + encodeURIComponent(taskId) + '?account=' + encodeURIComponent(account), { method: 'DELETE' });
    document.getElementById('gtask-' + taskId)?.remove();
    showToast('🗑 Tarea eliminada');
    loadGTasks();
  } catch { showToast('Error', false); btn.disabled = false; }
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init & polling ────────────────────────────────────────────────────────
async function refreshAll() {
  await Promise.all([loadMetrics(), loadStatus(), loadTasks()]);
}

refreshAll();
loadCalendar();
setInterval(refreshAll, 10_000);
setInterval(loadCalendar, 30_000);
</script>
</body>
</html>`;
}

export default router;
