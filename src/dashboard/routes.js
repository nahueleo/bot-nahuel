import { Router } from 'express';
import { listConnectedAccounts } from '../auth/google.js';
import { getHistory, setHistory, getMessageLog, logMessage } from '../conversation/store.js';
import { getRedisClient } from '../redis/client.js';
import { getPendingReminders } from '../redis/reminders.js';
import { getAllTasks, getTaskById, createTask, updateTask, deleteTask as deleteScheduledTask, getTaskLog } from '../redis/tasks.js';
import { sendWhatsAppMessage } from '../whatsapp/api.js';
import { processMessage } from '../ai/claude.js';
import { listAllCalendars, getEvents } from '../calendar/client.js';
import { runTask } from '../tasks/task-executor.js';
import { syncScheduler } from '../tasks/scheduler.js';
import { getToolDescriptors } from '../tasks/tool-registry.js';
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

// ─── API: enviar mensaje desde dashboard ──────────────────────────────────────
router.post('/api/messages/send', async (req, res) => {
  try {
    const body = req.body || {};
    const phone = String(body.phone || '').replace(/\D/g, '');
    const text = String(body.text || '').trim();
    const image = body.image || null;

    if (!phone || (!text && !image)) {
      return res.status(400).json({ error: 'Se requieren phone y texto o imagen' });
    }

    const history = await getHistory(phone);
    const { reply, updatedHistory } = await processMessage(text || ' ', history, image);
    await setHistory(phone, updatedHistory);
    await sendWhatsAppMessage(phone, reply);
    await logMessage(phone, text, reply, true);
    broadcastSSE('message', {
      from:      phone.slice(-4).padStart(10, '*'),
      text:      text.slice(0, 200),
      response:  reply.slice(0, 300),
      timestamp: new Date().toISOString(),
    });

    res.json({ ok: true, reply });
  } catch (err) {
    console.error('[dashboard] Error enviando mensaje AI:', err.message || err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

router.get('/api/chats', async (req, res) => {
  try {
    const redis = await getRedisClient();
    // Fuente principal: set persistente sin TTL
    // Fallback: conv:* (activos) + msgs:log (historial reciente)
    const [persistent, convKeys, logRaw] = await Promise.all([
      redis.sMembers('phones:contacts'),
      redis.keys('conv:*'),
      redis.lRange('msgs:log', 0, 499),
    ]);
    const phones = new Set(persistent);
    convKeys.forEach(k => phones.add(k.replace(/^conv:/, '')));
    for (const raw of logRaw) {
      try { const e = JSON.parse(raw); if (e.phone) phones.add(e.phone); } catch { /* skip */ }
    }
    res.json({ chats: [...phones].filter(Boolean).sort() });
  } catch (err) {
    console.error('[dashboard] Error obteniendo chats:', err.message || err);
    res.status(500).json({ error: 'Error obteniendo chats' });
  }
});

router.get('/api/messages/log', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    const logs = await getMessageLog(200);
    const filtered = phone ? logs.filter((m) => m.phone === phone) : logs;
    res.json({ logs: filtered.slice(0, 50) });
  } catch (err) {
    console.error('[dashboard] Error obteniendo log de mensajes:', err.message || err);
    res.status(500).json({ error: 'Error obteniendo log' });
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

// ─── API: tool descriptors ────────────────────────────────────────────────────
router.get('/api/tools', (_req, res) => {
  res.json({ tools: getToolDescriptors() });
});

// ─── API: tareas programadas — listado ────────────────────────────────────────
router.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await getAllTasks();
    res.json({ tasks });
  } catch {
    res.status(500).json({ error: 'Error obteniendo tareas' });
  }
});

// ─── API: tareas — obtener una ────────────────────────────────────────────────
router.get('/api/tasks/:id', async (req, res) => {
  try {
    const task = await getTaskById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    const log = await getTaskLog(req.params.id);
    res.json({ task, log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: crear tarea ─────────────────────────────────────────────────────────
router.post('/api/tasks', async (req, res) => {
  try {
    const body = req.body ?? {};
    if (!body.name?.trim()) return res.status(400).json({ error: 'El campo name es requerido' });
    if (body.phone && !/^\d{7,20}$/.test(body.phone)) {
      return res.status(400).json({ error: 'Número de teléfono inválido (solo dígitos, 7-20 chars)' });
    }
    const task = await createTask(body);
    await syncScheduler();
    res.status(201).json({ ok: true, task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: actualizar tarea ────────────────────────────────────────────────────
router.patch('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body ?? {};
    if (updates.phone !== undefined && updates.phone !== '' && !/^\d{7,20}$/.test(updates.phone)) {
      return res.status(400).json({ error: 'Número de teléfono inválido (solo dígitos, 7-20 chars)' });
    }
    const updated = await updateTask(id, updates);
    await syncScheduler();
    res.json({ ok: true, task: updated });
  } catch (err) {
    res.status(err.message?.includes('no encontrada') ? 404 : 500).json({ error: err.message });
  }
});

// ─── API: eliminar tarea ──────────────────────────────────────────────────────
router.delete('/api/tasks/:id', async (req, res) => {
  try {
    await deleteScheduledTask(req.params.id);
    await syncScheduler();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: ejecutar tarea ahora ────────────────────────────────────────────────
router.post('/api/tasks/:id/run', async (req, res) => {
  try {
    const result = await runTask(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: log de tarea ────────────────────────────────────────────────────────
router.get('/api/tasks/:id/log', async (req, res) => {
  try {
    const log = await getTaskLog(req.params.id);
    res.json({ log });
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
<link rel="icon" href="/favicon.ico" type="image/png">
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
input[type=text],input[type=time],select,textarea,input[type=file]{
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

/* ── Sidebar sub-items & connectors ── */
.nav-connector{display:flex;align-items:center;gap:10px;padding:10px 18px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;transition:all .15s;border-left:3px solid transparent}
.nav-connector:hover{background:var(--surface2);color:var(--text)}
.nav-subitem{padding:8px 18px 8px 42px !important;font-size:12px}
.nav-subitem:first-child{padding-top:4px !important}
.nav-subitem:last-child{padding-bottom:8px !important}

/* ── Task cards (multi-task UI) ── */
.task-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:12px;transition:border-color .2s}
.task-card:hover{border-color:rgba(59,130,246,.4)}
.task-card-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.task-card-emoji{font-size:20px;width:36px;height:36px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.task-card-name{font-size:15px;font-weight:700;color:#f1f5f9;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-card-meta{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.task-card-tools{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.tool-chip{font-size:11px;padding:3px 8px;border-radius:12px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);white-space:nowrap}
.task-card-footer{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.task-last-run{font-size:11px;color:var(--muted);margin-left:auto}

/* ── Tool builder in modal ── */
.tool-row{border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden;transition:border-color .2s}
.tool-row.enabled{border-color:var(--accent)}
.tool-row-head{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;user-select:none;background:var(--surface2)}
.tool-row-head:hover{background:#253346}
.tool-row-emoji{font-size:16px;width:26px;text-align:center;flex-shrink:0}
.tool-row-name{font-size:13px;font-weight:600;color:#f1f5f9;flex:1}
.tool-row-desc{font-size:11px;color:var(--muted);flex:2}
.tool-config{padding:14px;background:rgba(0,0,0,.2);border-top:1px solid var(--border)}
.multi-select-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;margin-top:4px}
.ms-chip{display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:12px;background:var(--surface2);transition:all .15s}
.ms-chip.selected{background:rgba(59,130,246,.15);border-color:var(--accent);color:#f1f5f9}
.ms-chip input{display:none}

/* ── WhatsApp Messages Tab ── */
#tab-messages.active{display:flex!important;flex-direction:column;height:100%;overflow:hidden;position:relative}
.wa-header{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 18px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.wa-avatar{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#25D366,#128C7E);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;box-shadow:0 2px 8px rgba(37,211,102,.3)}
.wa-header-info{flex:1;min-width:0}
.wa-contact-name-wrap{display:flex;align-items:center;gap:6px}
.wa-phone-sel{background:transparent;border:none;color:#f1f5f9;font-size:15px;font-weight:600;cursor:pointer;outline:none;max-width:220px;padding:0;font-family:inherit}
.wa-phone-sel option{background:#1f2937;color:#f1f5f9;font-weight:500}
.wa-contact-status{font-size:11px;color:#25D366;margin-top:2px;display:flex;align-items:center;gap:5px}
.wa-messages{flex:1;overflow-y:auto;padding:16px 20px;background:radial-gradient(ellipse at 20% 80%,rgba(18,140,126,.07) 0%,transparent 60%),linear-gradient(160deg,#080f1c 0%,#0b1829 100%);display:flex;flex-direction:column;gap:6px;scroll-behavior:smooth}
.wa-messages::-webkit-scrollbar{width:4px}
.wa-messages::-webkit-scrollbar-track{background:transparent}
.wa-messages::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px}
.wa-bubble{max-width:65%;padding:8px 14px 5px;position:relative;word-break:break-word;line-height:1.55;font-size:14px;animation:bubbleIn .18s ease}
@keyframes bubbleIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.wa-bubble.outgoing{align-self:flex-end;background:linear-gradient(135deg,#005C4B,#007a64);color:#e9edef;border-radius:14px 14px 3px 14px;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.wa-bubble.incoming{align-self:flex-start;background:#1a2537;color:#e2e8f0;border-radius:14px 14px 14px 3px;border:1px solid rgba(255,255,255,.06);box-shadow:0 1px 4px rgba(0,0,0,.3)}
.wa-bubble-text{white-space:pre-wrap}
.wa-bubble-time{font-size:10px;color:rgba(255,255,255,.45);text-align:right;margin-top:4px;display:flex;align-items:center;justify-content:flex-end;gap:3px}
.wa-bubble.outgoing .wa-bubble-time::after{content:'✓✓';color:#53bdeb;font-size:11px}
.wa-bubble img{max-width:220px;border-radius:10px;display:block;margin-bottom:5px}
.wa-date-divider{text-align:center;margin:8px 0;color:var(--muted);font-size:11px;display:flex;align-items:center;gap:10px}
.wa-date-divider::before,.wa-date-divider::after{content:'';flex:1;height:1px;background:rgba(255,255,255,.07)}
.wa-empty{text-align:center;color:var(--muted);font-size:13px;padding:48px 20px;margin:auto;display:flex;flex-direction:column;align-items:center;gap:10px}
.wa-empty-icon{font-size:40px;opacity:.4}
.wa-input-bar{background:var(--surface);border-top:1px solid var(--border);padding:10px 14px;display:flex;align-items:flex-end;gap:8px;flex-shrink:0}
.wa-attach-label{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;color:var(--muted);flex-shrink:0;transition:all .15s;user-select:none}
.wa-attach-label:hover{color:#25D366;background:rgba(37,211,102,.08)}
.wa-compose{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0}
.wa-text-area{width:100%;background:#1e2d3d;border:1px solid rgba(255,255,255,.1);border-radius:22px;color:#e9edef;padding:10px 16px;font-size:14px;resize:none;outline:none;overflow-y:hidden;line-height:1.45;min-height:42px;max-height:120px;display:block;font-family:inherit;transition:border-color .15s}
.wa-text-area::placeholder{color:#637080}
.wa-text-area:focus{border-color:rgba(37,211,102,.4)}
.wa-file-preview{font-size:12px;color:#25D366;padding:5px 12px;background:rgba(37,211,102,.07);border-radius:14px;border:1px solid rgba(37,211,102,.2);display:flex;align-items:center;gap:8px;animation:bubbleIn .2s ease}
.wa-file-preview-x{cursor:pointer;margin-left:auto;font-size:15px;line-height:1;color:var(--muted);padding:0 2px}
.wa-file-preview-x:hover{color:var(--red)}
.wa-send-btn{width:44px;height:44px;border-radius:50%;background:#25D366;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;color:white;flex-shrink:0;transition:all .15s;box-shadow:0 2px 8px rgba(37,211,102,.3)}
.wa-send-btn:hover{background:#20ba5a;transform:scale(1.05)}
.wa-send-btn:active{transform:scale(.95)}
.wa-send-btn:disabled{background:#2d3f52;cursor:not-allowed;box-shadow:none;transform:none}
@media(max-width:768px){
  .wa-bubble{max-width:82%}
  .wa-messages{padding:12px}
  .wa-phone-sel{max-width:160px}
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
  <div class="nav-item active" data-tab="overview"><span class="nav-icon">📊</span> Dashboard</div>
  <div class="nav-item" data-tab="tasks">          <span class="nav-icon">⚙️</span> Tareas programadas</div>

  <div class="nav-section">Conectores</div>

  <!-- WhatsApp -->
  <div class="nav-item nav-connector" id="nav-whatsapp" onclick="goToTab('messages')">
    <span class="nav-icon">📱</span>
    <span style="flex:1">WhatsApp</span>
    <span id="wa-conn-badge" style="font-size:10px;padding:2px 7px;border-radius:10px;background:#14532d;color:#86efac;font-weight:600">online</span>
  </div>

  <!-- Google (expandible) -->
  <div class="nav-item nav-connector" id="nav-google-header" onclick="toggleGoogleMenu()">
    <span class="nav-icon">🔵</span>
    <span style="flex:1">Google</span>
    <span id="google-expand-icon" style="font-size:11px;color:var(--muted);transition:transform .2s">▶</span>
  </div>
  <div id="google-submenu" style="display:none;overflow:hidden">
    <div class="nav-item nav-subitem" data-tab="gmail">      <span class="nav-icon" style="font-size:13px">📧</span> Gmail</div>
    <div class="nav-item nav-subitem" data-tab="calendar">   <span class="nav-icon" style="font-size:13px">📅</span> Calendario</div>
    <div class="nav-item nav-subitem" data-tab="gtasks">     <span class="nav-icon" style="font-size:13px">✅</span> Google Tasks</div>
  </div>
  <div id="google-configure" style="display:none;padding:4px 12px 8px">
    <a href="/auth/google?account=nueva" class="btn btn-ghost" style="justify-content:center;width:100%;font-size:12px">+ Conectar Google</a>
  </div>

  <div class="nav-section">Sistema</div>
  <div class="nav-item" data-tab="system"><span class="nav-icon">🔧</span> Sistema</div>
  <div style="padding:8px 12px">
    <a href="/health" target="_blank" class="btn btn-ghost" style="justify-content:center;width:100%;font-size:12px">💚 Health</a>
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
    <!-- Tareas programadas preview -->
    <div class="card">
      <div class="card-title">⚙️ <span>Tareas Programadas</span></div>
      <div id="overview-task-status"><div class="empty" style="padding:8px 0">Cargando...</div></div>
      <div class="flex-row mt-12">
        <button class="btn btn-ghost" onclick="goToTab('tasks')">Ver todas →</button>
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

  <!-- Header + botón nueva tarea -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
    <h2 style="font-size:18px;font-weight:700;color:#f1f5f9">⚙️ Tareas Programadas</h2>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost" onclick="loadTasks()">↻ Recargar</button>
      <button class="btn btn-primary" onclick="openTaskModal(null)">+ Nueva Tarea</button>
    </div>
  </div>

  <!-- Lista de tareas -->
  <div id="tasks-list"><div class="empty" style="padding:48px 0">Cargando tareas...</div></div>

  <!-- Panel de log (colapsable) -->
  <div id="task-log-panel" style="display:none">
    <div class="card" style="margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">📋 <span id="log-panel-title">Últimas ejecuciones</span></div>
        <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="closeLogPanel()">✕</button>
      </div>
      <div class="log-list" id="task-log-list" style="max-height:300px"></div>
    </div>
  </div>
</div>

<!-- ═══════════ MODAL: CREAR / EDITAR TAREA ═══════════ -->
<div id="task-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;overflow-y:auto;padding:20px">
<div id="task-modal" style="background:var(--surface);border:1px solid var(--border);border-radius:16px;max-width:680px;margin:0 auto;padding:28px;position:relative">

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
    <h3 id="modal-title" style="font-size:17px;font-weight:700;color:#f1f5f9">Nueva Tarea</h3>
    <button onclick="closeTaskModal()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:20px;line-height:1;padding:4px">✕</button>
  </div>

  <!-- Nombre + emoji -->
  <div class="grid-2">
    <div class="field">
      <label>Emoji</label>
      <input type="text" id="modal-emoji" value="🤖" maxlength="4" style="font-size:22px;text-align:center;width:70px">
    </div>
    <div class="field" style="flex:1">
      <label>Nombre de la tarea</label>
      <input type="text" id="modal-name" placeholder="Ej: Resumen mañanero">
    </div>
  </div>

  <!-- Horario -->
  <div class="field">
    <label>Tipo de horario</label>
    <select id="modal-schedule-type" onchange="onScheduleTypeChange()">
      <option value="daily">Todos los días</option>
      <option value="weekdays">Lunes a Viernes</option>
      <option value="weekends">Sábado y Domingo</option>
      <option value="weekly">Días específicos</option>
      <option value="custom">Cron personalizado</option>
    </select>
  </div>

  <div id="modal-time-row" class="field">
    <label>Hora de envío</label>
    <input type="time" id="modal-time" value="07:00">
  </div>

  <div id="modal-days-row" style="display:none" class="field">
    <label>Días de la semana</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
      ${['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'].map((d,i) =>
        `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;padding:5px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;font-size:12px;font-weight:600">
          <input type="checkbox" data-day="${i}" class="day-chk" ${i>=1&&i<=5?'checked':''}> ${d}
        </label>`
      ).join('')}
    </div>
  </div>

  <div id="modal-cron-row" style="display:none" class="field">
    <label>Expresión Cron (timezone: America/Argentina/Buenos_Aires)</label>
    <input type="text" id="modal-cron" placeholder="0 7 * * 1-5  →  Lun-Vie a las 07:00">
  </div>

  <!-- Teléfono -->
  <div class="field">
    <label>Número WhatsApp destino (solo dígitos)</label>
    <input type="text" id="modal-phone" placeholder="549XXXXXXXXXX">
  </div>

  <!-- Herramientas -->
  <div class="field" style="margin-top:4px">
    <label>Herramientas incluidas</label>
    <p style="font-size:12px;color:var(--muted);margin-bottom:10px">Activá las que quieras. Cada una se envía como una sección del mensaje.</p>
    <div id="modal-tools-list"></div>
  </div>

  <!-- Botones -->
  <div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end">
    <button class="btn btn-ghost" onclick="closeTaskModal()">Cancelar</button>
    <button class="btn btn-primary" onclick="saveTask()" id="modal-save-btn">Guardar tarea</button>
  </div>

  <input type="hidden" id="modal-task-id" value="">
</div>
</div>

<!-- ════════════════════ TAB: MENSAJES ════════════════════ -->
<div class="tab-content" id="tab-messages">
  <!-- Header estilo WhatsApp -->
  <div class="wa-header">
    <div class="wa-avatar">💬</div>
    <div class="wa-header-info">
      <div class="wa-contact-name-wrap">
        <span id="wa-active-contact" style="font-size:15px;font-weight:600;color:#f1f5f9">Sin chat</span>
        <button id="wa-switch-btn" onclick="toggleChatPicker()" title="Cambiar contacto"
          style="display:none;background:rgba(255,255,255,.08);border:none;border-radius:6px;color:var(--muted);cursor:pointer;font-size:11px;padding:3px 8px;margin-left:6px">▼</button>
      </div>
      <div class="wa-contact-status">
        <span class="dot dot-green dot-pulse" style="width:7px;height:7px;flex-shrink:0"></span>
        en vivo · WhatsApp
      </div>
    </div>
  </div>
  <!-- Chat picker overlay (múltiples contactos) -->
  <div id="wa-chat-picker" style="display:none;position:absolute;top:70px;left:16px;right:16px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;z-index:50;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.4)">
    <div style="padding:10px 14px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Contactos</div>
    <div id="wa-chat-picker-list"></div>
  </div>
  <!-- Hidden select para controlar el valor activo -->
  <select id="send-phone" style="display:none"></select>
  <!-- Área de mensajes -->
  <div class="wa-messages" id="chat-thread">
    <div class="wa-empty">
      <span class="wa-empty-icon">💬</span>
      Seleccioná un chat para ver el historial
    </div>
  </div>
  <!-- Barra de entrada -->
  <div class="wa-input-bar">
    <label class="wa-attach-label" for="send-image" title="Adjuntar imagen">📎</label>
    <input type="file" id="send-image" accept="image/*" style="display:none" onchange="onFileSelected(this)">
    <div class="wa-compose">
      <div id="wa-file-preview" style="display:none"></div>
      <textarea class="wa-text-area" id="send-text" placeholder="Escribir mensaje..."
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendDashboardMessage()}"
        oninput="autoResize(this)"></textarea>
    </div>
    <button class="wa-send-btn" id="send-message-btn" onclick="sendDashboardMessage()" title="Enviar">
      <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
    </button>
  </div>
</div>

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

function chatBubble(content, role, timestamp) {
  const d = document.createElement('div');
  d.className = 'wa-bubble ' + (role === 'user' ? 'outgoing' : 'incoming');
  const imgHtml = content.image ? '<img src="' + content.image + '" alt="imagen">' : '';
  const textHtml = content.text
    ? '<div class="wa-bubble-text">' + esc(content.text) + '</div>'
    : '';
  const time = timestamp
    ? new Date(timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
    : '';
  d.innerHTML = imgHtml + textHtml + '<div class="wa-bubble-time">' + time + '</div>';
  return d;
}

function renderChatHistory(logs) {
  const thread = document.getElementById('chat-thread');
  if (!thread) return;
  if (!logs || !logs.length) {
    thread.innerHTML = '<div class="wa-empty"><span class="wa-empty-icon">💬</span>Sin mensajes en este chat</div>';
    return;
  }
  thread.innerHTML = '';
  let lastDate = '';
  logs.forEach((log) => {
    const timestamp = log.timestamp || new Date().toISOString();
    const dateStr = new Date(timestamp).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if (dateStr !== lastDate) {
      const div = document.createElement('div');
      div.className = 'wa-date-divider';
      div.textContent = dateStr;
      thread.appendChild(div);
      lastDate = dateStr;
    }
    if (log.text) thread.appendChild(chatBubble({ text: log.text }, 'user', timestamp));
    if (log.response) thread.appendChild(chatBubble({ text: log.response }, 'bot', timestamp));
  });
  thread.scrollTop = thread.scrollHeight;
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function goToTab(id) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + id)?.classList.add('active');
  document.querySelector('[data-tab=' + id + ']')?.classList.add('active');
  const panel = document.querySelector('.panel');
  if (id === 'messages') {
    panel.style.overflow = 'hidden';
    panel.style.padding = '0';
  } else {
    panel.style.overflow = '';
    panel.style.padding = '';
  }
  if (id === 'messages') loadChatList();
  if (id === 'calendar') loadCalendar();
  if (id === 'gmail') loadGmail();
  if (id === 'gtasks') loadGTasks();
  if (id === 'tasks') loadTasks();
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
  const ovEl = document.getElementById('overview-msgs');
  if (ovEl) {
    if (ovEl.querySelector('.empty')) ovEl.innerHTML = '';
    ovEl.prepend(msgCard(m, true));
    while (ovEl.children.length > 50) ovEl.lastChild.remove();
  }
  // Agregar el nuevo mensaje al chat sin re-renderizar todo
  const phone = document.getElementById('send-phone')?.value;
  if (phone && document.getElementById('tab-messages')?.classList.contains('active')) {
    const thread = document.getElementById('chat-thread');
    if (thread && !thread.querySelector('.wa-empty')) {
      const now = new Date().toISOString();
      if (m.text)     thread.appendChild(chatBubble({ text: m.text },     'user', now));
      if (m.response) thread.appendChild(chatBubble({ text: m.response }, 'bot',  now));
      thread.scrollTop = thread.scrollHeight;
    }
  }
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

    // Sidebar: mostrar/ocultar Google según si hay cuentas configuradas
    const googleSub = document.getElementById('google-submenu');
    const googleConf = document.getElementById('google-configure');
    const googleIcon = document.getElementById('google-expand-icon');
    if (accs.length > 0) {
      if (googleConf) googleConf.style.display = 'none';
      if (googleSub) { googleSub.style.display = 'block'; if (googleIcon) googleIcon.style.transform = 'rotate(90deg)'; }
    } else {
      if (googleSub) googleSub.style.display = 'none';
      if (googleConf) googleConf.style.display = 'block';
    }

    // Overview messages preview
    if (d.messages?.length) {
      const ovEl = document.getElementById('overview-msgs');
      if (ovEl) { ovEl.innerHTML = ''; d.messages.slice(0, 5).forEach(m => ovEl.appendChild(msgCard(m))); }
    }
    // Solo carga la lista de chats en el init, no en cada poll de 10 segundos
    if (!_chatListLoaded) { _chatListLoaded = true; await loadChatList(); }
  } catch (err) {
    console.error('[dashboard] Error cargando estado:', err);
    document.getElementById('status-badge').textContent = '● Offline';
    document.getElementById('status-badge').className = 'topbar-badge badge-off';
  }
}

// ── Calendar & Reminders ──────────────────────────────────────────────────
let _calAccounts = [];
let _chatListLoaded = false;

async function loadChatList() {
  try {
    const select = document.getElementById('send-phone');
    const btn = document.getElementById('send-message-btn');
    const contactLabel = document.getElementById('wa-active-contact');
    const switchBtn = document.getElementById('wa-switch-btn');
    const pickerList = document.getElementById('wa-chat-picker-list');
    if (!select) return;

    // Obtener chats — si /api/chats devuelve vacío, extraer teléfonos del log
    let chats = (await fetch('/api/chats').then(r => r.json()).catch(() => ({}))).chats || [];
    if (!chats.length) {
      const logData = await fetch('/api/messages/log').then(r => r.json()).catch(() => ({}));
      const seen = new Set();
      for (const m of (logData.logs || [])) {
        if (m.phone && !seen.has(m.phone)) { seen.add(m.phone); chats.push(m.phone); }
      }
    }

    if (!chats.length) {
      select.innerHTML = '<option value="">Sin chats</option>';
      if (btn) btn.disabled = true;
      if (contactLabel) contactLabel.textContent = 'Sin contactos';
      renderChatHistory([]);
      return;
    }

    const prevValue = select.value;
    select.innerHTML = chats.map(c => '<option value="' + c + '">' + c + '</option>').join('');
    if (prevValue && chats.includes(prevValue)) select.value = prevValue;
    if (btn) btn.disabled = false;

    // Actualizar header con número enmascarado
    const activePhone = select.value;
    if (contactLabel) contactLabel.textContent = activePhone.slice(-4).padStart(activePhone.length, '*');
    if (switchBtn) switchBtn.style.display = chats.length > 1 ? 'inline-block' : 'none';

    // Poblar picker con DOM puro (evita problemas de escaping en template literal)
    if (pickerList) {
      pickerList.innerHTML = '';
      chats.forEach(phone => {
        const masked = phone.slice(-4).padStart(phone.length, '*');
        const item = document.createElement('div');
        item.style.cssText = 'padding:12px 14px;cursor:pointer;font-size:14px;color:#f1f5f9;border-bottom:1px solid rgba(255,255,255,.04);transition:background .1s';
        item.innerHTML = '<span style="font-size:16px;margin-right:10px">📱</span>' + esc(masked);
        item.addEventListener('click', () => selectChat(phone));
        item.addEventListener('mouseover', () => { item.style.background = 'rgba(255,255,255,.05)'; });
        item.addEventListener('mouseout', () => { item.style.background = ''; });
        pickerList.appendChild(item);
      });
    }

    await loadChatHistory(select.value);
  } catch (err) {
    console.error('Error cargando chats:', err);
  }
}

function selectChat(phone) {
  const select = document.getElementById('send-phone');
  const label = document.getElementById('wa-active-contact');
  if (select) select.value = phone;
  if (label) label.textContent = phone.slice(-4).padStart(phone.length, '*');
  toggleChatPicker(false);
  loadChatHistory(phone);
}

function toggleChatPicker(force) {
  const picker = document.getElementById('wa-chat-picker');
  if (!picker) return;
  const show = force !== undefined ? force : picker.style.display === 'none';
  picker.style.display = show ? 'block' : 'none';
}

function toggleGoogleMenu() {
  const sub = document.getElementById('google-submenu');
  const icon = document.getElementById('google-expand-icon');
  const isOpen = sub.style.display !== 'none';
  sub.style.display = isOpen ? 'none' : 'block';
  if (icon) icon.style.transform = isOpen ? '' : 'rotate(90deg)';
}

async function loadChatHistory(phone) {
  try {
    const thread = document.getElementById('chat-thread');
    if (!thread) return;
    if (!phone) {
      renderChatHistory([]);
      return;
    }
    const data = await fetch('/api/messages/log?phone=' + encodeURIComponent(phone)).then(r => r.json());
    // El log viene newest-first (lPush), invertir para mostrar cronológicamente
    renderChatHistory((data.logs || []).slice().reverse());
  } catch (err) {
    console.error('Error cargando historial de chat:', err);
  }
}

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

// ── Tasks (multi-task system) ──────────────────────────────────────────────
let _allTools = [];  // cached tool descriptors from /api/tools

async function ensureTools() {
  if (_allTools.length) return _allTools;
  try {
    const { tools } = await fetch('/api/tools').then(r => r.json());
    _allTools = tools || [];
  } catch { _allTools = []; }
  return _allTools;
}

async function loadTasks() {
  const listEl  = document.getElementById('tasks-list');
  const ovCard  = document.getElementById('overview-task-status');

  try {
    const { tasks } = await fetch('/api/tasks').then(r => r.json());
    await ensureTools();

    // ── Overview card ──
    if (ovCard) {
      if (!tasks?.length) {
        ovCard.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:4px 0">Sin tareas aún. <a href="#" onclick="goToTab(\'tasks\');return false">Crear una →</a></div>';
      } else {
        const enabled = tasks.filter(t => t.enabled);
        ovCard.innerHTML = tasks.slice(0,3).map(t =>
          '<div class="stat-row"><span class="stat-lbl">' + t.emoji + ' ' + escHtml(t.name) + '</span>' +
          '<span class="stat-val">' + (t.enabled ? '<span style="color:var(--green)">●</span> Activa' : '<span style="color:var(--muted)">● Inactiva</span>') + '</span></div>'
        ).join('') +
        (tasks.length > 3 ? '<div style="font-size:11px;color:var(--muted);margin-top:6px">+ ' + (tasks.length-3) + ' más</div>' : '');
      }
    }

    // ── Tasks list tab ──
    if (!listEl) return;
    if (!tasks?.length) {
      listEl.innerHTML = '<div class="empty" style="padding:60px 0">' +
        '<div style="font-size:40px;margin-bottom:12px">⚙️</div>' +
        '<div style="margin-bottom:16px">No hay tareas programadas todavía.</div>' +
        '<button class="btn btn-primary" onclick="openTaskModal(null)">+ Crear primera tarea</button>' +
        '</div>';
      return;
    }

    listEl.innerHTML = tasks.map(task => renderTaskCard(task)).join('');
  } catch (e) {
    console.error('Error cargando tareas:', e);
    if (listEl) listEl.innerHTML = '<div class="empty">Error cargando tareas</div>';
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderTaskCard(task) {
  const scheduleDesc = scheduleDescText(task.schedule);
  const lastRunText  = task.lastRun
    ? (task.lastStatus === 'ok' ? '✅ ' : '❌ ') + 'Último envío: ' + fmt(task.lastRun)
    : 'Nunca ejecutado';

  const toolChips = (task.tools || []).map(t => {
    const def = _allTools.find(x => x.id === t.id);
    if (!def) return '';
    return '<span class="tool-chip">' + def.emoji + ' ' + def.name + '</span>';
  }).join('');

  return '<div class="task-card" id="tcard-' + task.id + '">' +
    '<div class="task-card-head">' +
      '<div class="task-card-emoji">' + (task.emoji || '🤖') + '</div>' +
      '<div class="task-card-name">' + escHtml(task.name) + '</div>' +
      '<span class="task-status ' + (task.enabled ? 'on' : 'off') + '" style="font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;margin-left:4px">' +
        (task.enabled ? 'Activa' : 'Inactiva') + '</span>' +
    '</div>' +
    '<div class="task-card-meta">' +
      '<span>🕐 ' + escHtml(scheduleDesc) + '</span>' +
      (task.phone ? '<span>📱 +' + task.phone.slice(-6).padStart(10,'*') + '</span>' : '') +
    '</div>' +
    (toolChips ? '<div class="task-card-tools">' + toolChips + '</div>' : '') +
    '<div class="task-card-footer">' +
      '<button class="btn btn-success" style="padding:6px 12px;font-size:12px" onclick="runTaskNow(\'' + task.id + '\',this)">▶ Enviar ahora</button>' +
      '<button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" onclick="openTaskModal(\'' + task.id + '\')">✏️ Editar</button>' +
      '<button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" onclick="showTaskLog(\'' + task.id + '\',\'' + escHtml(task.name) + '\')">📋 Logs</button>' +
      '<button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;color:var(--red)" onclick="deleteTask(\'' + task.id + '\',\'' + escHtml(task.name) + '\')">🗑</button>' +
      '<label class="toggle" style="margin-left:auto" title="Activar/desactivar">' +
        '<input type="checkbox" ' + (task.enabled ? 'checked' : '') + ' onchange="toggleTask(\'' + task.id + '\',this.checked)">' +
        '<span class="slider"></span></label>' +
      '<span class="task-last-run">' + lastRunText + '</span>' +
    '</div>' +
  '</div>';
}

function scheduleDescText(schedule) {
  if (!schedule) return 'Sin configurar';
  if (schedule.type === 'custom') return 'Cron: ' + (schedule.cron || '?');
  const time = schedule.time || '07:00';
  const D = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  switch (schedule.type) {
    case 'weekdays': return 'Lun–Vie a las ' + time;
    case 'weekends': return 'Sáb–Dom a las ' + time;
    case 'weekly': return (schedule.days || []).map(d => D[d]).join(', ') + ' a las ' + time;
    default: return 'Todos los días a las ' + time;
  }
}

async function toggleTask(id, enabled) {
  try {
    const r = await fetch('/api/tasks/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then(r => r.json());
    if (r.error) { showToast('Error: ' + r.error, false); loadTasks(); return; }
    showToast(enabled ? '✅ Tarea activada' : '⏸ Tarea desactivada');
    loadTasks();
  } catch { showToast('Error de conexión', false); }
}

async function runTaskNow(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando...'; }
  try {
    const r = await fetch('/api/tasks/' + id + '/run', { method: 'POST' }).then(r => r.json());
    if (r.success) showToast('✅ Tarea enviada correctamente');
    else showToast('❌ Error: ' + (r.error || 'desconocido'), false);
    loadTasks();
  } catch { showToast('Error de conexión', false); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '▶ Enviar ahora'; } }
}

async function deleteTask(id, name) {
  if (!confirm('¿Eliminar la tarea "' + name + '"? Esta acción no se puede deshacer.')) return;
  try {
    const r = await fetch('/api/tasks/' + id, { method: 'DELETE' }).then(r => r.json());
    if (r.error) { showToast('Error: ' + r.error, false); return; }
    showToast('🗑 Tarea eliminada');
    loadTasks();
  } catch { showToast('Error de conexión', false); }
}

async function showTaskLog(id, name) {
  const panel = document.getElementById('task-log-panel');
  const listEl = document.getElementById('task-log-list');
  const titleEl = document.getElementById('log-panel-title');
  if (!panel) return;

  titleEl.textContent = 'Últimas ejecuciones — ' + name;
  listEl.innerHTML = '<div class="empty">Cargando...</div>';
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const { log } = await fetch('/api/tasks/' + id + '/log').then(r => r.json());
    if (!log?.length) { listEl.innerHTML = '<div class="empty">Sin ejecuciones registradas</div>'; return; }
    listEl.innerHTML = log.map(l =>
      '<div class="log-item">' +
        '<span class="log-icon">' + (l.status === 'ok' ? '✅' : '❌') + '</span>' +
        '<span>' + fmt(l.ts) + '</span>' +
        (l.error ? '<span style="color:var(--red)">— ' + escHtml(l.error) + '</span>' : '<span style="color:var(--muted)">— ok</span>') +
        (l.chars ? '<span style="color:var(--muted)">' + l.chars + ' chars</span>' : '') +
      '</div>'
    ).join('');
  } catch { listEl.innerHTML = '<div class="empty">Error cargando log</div>'; }
}

function closeLogPanel() {
  const p = document.getElementById('task-log-panel');
  if (p) p.style.display = 'none';
}

// ─── Modal: crear / editar tarea ──────────────────────────────────────────────
let _editingTaskId = null;
let _toolStates = {};  // { toolId: { enabled, config } }

async function openTaskModal(taskId) {
  _editingTaskId = taskId;
  _toolStates = {};
  const overlay = document.getElementById('task-modal-overlay');
  const titleEl = document.getElementById('modal-title');

  await ensureTools();

  if (taskId) {
    titleEl.textContent = '✏️ Editar Tarea';
    try {
      const { task } = await fetch('/api/tasks/' + taskId).then(r => r.json());
      document.getElementById('modal-task-id').value = task.id;
      document.getElementById('modal-emoji').value   = task.emoji || '🤖';
      document.getElementById('modal-name').value    = task.name  || '';
      document.getElementById('modal-phone').value   = task.phone || '';

      const sched = task.schedule || {};
      document.getElementById('modal-schedule-type').value = sched.type || 'daily';
      document.getElementById('modal-time').value  = sched.time || '07:00';
      document.getElementById('modal-cron').value  = sched.cron || '';

      // Restore day checkboxes
      const dayChks = document.querySelectorAll('.day-chk');
      const selDays = sched.days || [1,2,3,4,5];
      dayChks.forEach(chk => { chk.checked = selDays.includes(Number(chk.dataset.day)); });

      // Load tool states
      for (const te of task.tools || []) {
        _toolStates[te.id] = { enabled: true, config: te.config ?? {} };
      }
    } catch { showToast('Error cargando tarea', false); return; }
  } else {
    titleEl.textContent = '+ Nueva Tarea';
    document.getElementById('modal-task-id').value = '';
    document.getElementById('modal-emoji').value   = '🤖';
    document.getElementById('modal-name').value    = '';
    document.getElementById('modal-phone').value   = '';
    document.getElementById('modal-schedule-type').value = 'daily';
    document.getElementById('modal-time').value    = '07:00';
    document.getElementById('modal-cron').value    = '';
    document.querySelectorAll('.day-chk').forEach((c,i) => { c.checked = i>=1&&i<=5; });
  }

  onScheduleTypeChange();
  renderToolsInModal();

  overlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function closeTaskModal() {
  document.getElementById('task-modal-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

function onScheduleTypeChange() {
  const type = document.getElementById('modal-schedule-type').value;
  document.getElementById('modal-time-row').style.display  = type !== 'custom' ? '' : 'none';
  document.getElementById('modal-days-row').style.display  = type === 'weekly' ? '' : 'none';
  document.getElementById('modal-cron-row').style.display  = type === 'custom' ? '' : 'none';
}

function renderToolsInModal() {
  const container = document.getElementById('modal-tools-list');
  if (!container) return;

  container.innerHTML = _allTools.map(tool => {
    const state  = _toolStates[tool.id] || { enabled: false, config: {} };
    const cfg    = state.config || {};
    const isOn   = !!state.enabled;

    // Build config fields HTML
    const fieldsHtml = (tool.configFields || []).map(field => {
      if (field.type === 'text') {
        return '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">' + field.label + '</label>' +
          '<input type="text" data-tool="' + tool.id + '" data-key="' + field.key + '" ' +
          'value="' + escHtml(cfg[field.key] ?? field.placeholder ?? '') + '" placeholder="' + escHtml(field.placeholder || '') + '" ' +
          'oninput="onToolConfigChange(\'' + tool.id + '\',\'' + field.key + '\',this.value)"></div>';
      }
      if (field.type === 'number') {
        return '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">' + field.label + '</label>' +
          '<input type="number" min="' + (field.min||1) + '" max="' + (field.max||99) + '" data-tool="' + tool.id + '" data-key="' + field.key + '" ' +
          'value="' + (cfg[field.key] ?? field.default ?? field.min ?? 1) + '" ' +
          'oninput="onToolConfigChange(\'' + tool.id + '\',\'' + field.key + '\',+this.value)"></div>';
      }
      if (field.type === 'select') {
        const opts = field.options.map(o =>
          '<option value="' + escHtml(o.value) + '"' + (cfg[field.key]===o.value?' selected':'') + '>' + escHtml(o.label) + '</option>'
        ).join('');
        return '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">' + field.label + '</label>' +
          '<select data-tool="' + tool.id + '" data-key="' + field.key + '" onchange="onToolConfigChange(\'' + tool.id + '\',\'' + field.key + '\',this.value)">' + opts + '</select></div>';
      }
      if (field.type === 'account-select') {
        const accs = _calAccounts || [];
        const opts = '<option value="">— Automático —</option>' +
          accs.map(a => '<option value="' + escHtml(a) + '"' + (cfg[field.key]===a?' selected':'') + '>' + escHtml(a) + '</option>').join('');
        return '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">' + field.label + '</label>' +
          '<select data-tool="' + tool.id + '" data-key="' + field.key + '" onchange="onToolConfigChange(\'' + tool.id + '\',\'' + field.key + '\',this.value)">' + opts + '</select></div>';
      }
      if (field.type === 'multi-select') {
        const selected = Array.isArray(cfg[field.key]) ? cfg[field.key] : (tool.defaultConfig?.[field.key] ?? []);
        const chips = field.options.map(o => {
          const isSel = selected.includes(o.value);
          return '<label class="ms-chip ' + (isSel?'selected':'') + '" onclick="toggleMultiSelect(\'' + tool.id + '\',\'' + field.key + '\',\'' + o.value + '\',this)">' +
            '<input type="checkbox" ' + (isSel?'checked':'') + '>' + escHtml(o.label) + '</label>';
        }).join('');
        return '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">' + field.label + '</label>' +
          '<div class="multi-select-grid">' + chips + '</div></div>';
      }
      if (field.type === 'textarea') {
        return '<div class="field" style="margin-bottom:8px"><label style="font-size:11px">' + field.label + '</label>' +
          '<textarea data-tool="' + tool.id + '" data-key="' + field.key + '" rows="3" placeholder="' + escHtml(field.placeholder||'') + '" ' +
          'oninput="onToolConfigChange(\'' + tool.id + '\',\'' + field.key + '\',this.value)">' + escHtml(cfg[field.key]||'') + '</textarea></div>';
      }
      return '';
    }).join('');

    return '<div class="tool-row ' + (isOn?'enabled':'') + '" id="trow-' + tool.id + '">' +
      '<div class="tool-row-head" onclick="toggleToolRow(\'' + tool.id + '\')">' +
        '<span class="tool-row-emoji">' + tool.emoji + '</span>' +
        '<span class="tool-row-name">' + tool.name + '</span>' +
        '<span class="tool-row-desc">' + tool.description + '</span>' +
        '<label class="toggle" style="flex-shrink:0" onclick="event.stopPropagation()">' +
          '<input type="checkbox" id="tool-toggle-' + tool.id + '" ' + (isOn?'checked':'') + ' onchange="onToolToggle(\'' + tool.id + '\',this.checked)">' +
          '<span class="slider"></span></label>' +
      '</div>' +
      (tool.configFields.length ? '<div class="tool-config" id="tcfg-' + tool.id + '" style="display:' + (isOn?'block':'none') + '">' + fieldsHtml + '</div>' : '') +
    '</div>';
  }).join('');
}

function toggleToolRow(toolId) {
  const chk = document.getElementById('tool-toggle-' + toolId);
  if (chk) { chk.checked = !chk.checked; onToolToggle(toolId, chk.checked); }
}

function onToolToggle(toolId, enabled) {
  if (!_toolStates[toolId]) {
    const def = _allTools.find(t => t.id === toolId);
    _toolStates[toolId] = { enabled, config: structuredClone(def?.defaultConfig ?? {}) };
  } else {
    _toolStates[toolId].enabled = enabled;
  }
  const row = document.getElementById('trow-' + toolId);
  if (row) row.classList.toggle('enabled', enabled);
  const cfg = document.getElementById('tcfg-' + toolId);
  if (cfg) cfg.style.display = enabled ? 'block' : 'none';
}

function onToolConfigChange(toolId, key, value) {
  if (!_toolStates[toolId]) {
    const def = _allTools.find(t => t.id === toolId);
    _toolStates[toolId] = { enabled: true, config: structuredClone(def?.defaultConfig ?? {}) };
  }
  _toolStates[toolId].config[key] = value;
}

function toggleMultiSelect(toolId, key, value, labelEl) {
  if (!_toolStates[toolId]) {
    const def = _allTools.find(t => t.id === toolId);
    _toolStates[toolId] = { enabled: true, config: structuredClone(def?.defaultConfig ?? {}) };
  }
  const arr = _toolStates[toolId].config[key] || [];
  const idx = arr.indexOf(value);
  if (idx === -1) arr.push(value);
  else arr.splice(idx, 1);
  _toolStates[toolId].config[key] = arr;
  labelEl.classList.toggle('selected', idx === -1);
  labelEl.querySelector('input').checked = idx === -1;
}

async function saveTask() {
  const btn  = document.getElementById('modal-save-btn');
  const name = document.getElementById('modal-name').value.trim();
  if (!name) { showToast('El nombre de la tarea es requerido', false); return; }

  const schedType = document.getElementById('modal-schedule-type').value;
  const schedule  = { type: schedType };
  if (schedType !== 'custom') {
    schedule.time = document.getElementById('modal-time').value;
  }
  if (schedType === 'weekly') {
    schedule.days = [...document.querySelectorAll('.day-chk')].filter(c => c.checked).map(c => +c.dataset.day);
  }
  if (schedType === 'custom') {
    schedule.cron = document.getElementById('modal-cron').value.trim();
  }

  const tools = _allTools
    .filter(t => _toolStates[t.id]?.enabled)
    .map(t => ({ id: t.id, config: _toolStates[t.id]?.config ?? {} }));

  const payload = {
    name,
    emoji:    document.getElementById('modal-emoji').value.trim() || '🤖',
    phone:    document.getElementById('modal-phone').value.trim(),
    schedule,
    tools,
    enabled:  true,
  };

  btn.disabled = true; btn.textContent = 'Guardando...';
  try {
    const taskId = document.getElementById('modal-task-id').value;
    let r;
    if (taskId) {
      r = await fetch('/api/tasks/' + taskId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then(r => r.json());
    } else {
      r = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then(r => r.json());
    }
    if (r.error) { showToast('Error: ' + r.error, false); return; }
    showToast('✅ Tarea guardada correctamente');
    closeTaskModal();
    loadTasks();
  } catch { showToast('Error de conexión', false); }
  finally { btn.disabled = false; btn.textContent = 'Guardar tarea'; }
}

// Close modal on overlay click
document.getElementById('task-modal-overlay')?.addEventListener('click', function(e) {
  if (e.target === this) closeTaskModal();
});

async function sendDashboardMessage() {
  const phoneEl = document.getElementById('send-phone');
  const textEl = document.getElementById('send-text');
  const imageEl = document.getElementById('send-image');
  const btn = document.getElementById('send-message-btn');
  const phone = String(phoneEl?.value || '').trim();
  const text = String(textEl?.value || '').trim();
  const file = imageEl?.files?.[0] || null;

  if (!phone || (!text && !file)) {
    showToast('Seleccioná un chat y escribí un mensaje o subí una imagen', false);
    return;
  }

  btn.disabled = true;

  let image = null;
  if (file) {
    const reader = new FileReader();
    image = await new Promise((resolve, reject) => {
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve({ base64, mimeType: file.type });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  try {
    const body = { phone, text };
    if (image) body.image = image;
    const r = await fetch('/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());

    if (r.error) {
      showToast('Error: ' + r.error, false);
      return;
    }

    showToast('✅ Mensaje enviado y bot respondió');
    textEl.value = '';
    textEl.style.height = '';
    clearFileInput();
    await loadChatHistory(phone);
  } catch (err) {
    showToast('Error de conexión', false);
  } finally {
    btn.disabled = false;
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
          ? '<button data-account="' + esc(account) + '" data-id="' + esc(e.id) + '" onclick="markEmailRead(this.dataset.account,this.dataset.id,this)" style="flex-shrink:0;padding:4px 10px;font-size:11px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;cursor:pointer">✓ Leído</button>'
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
        '<button data-account="' + esc(account) + '" data-id="' + esc(t.id) + '" onclick="completeGTask(this.dataset.account,this.dataset.id,this)" ' +
          'style="width:22px;height:22px;border-radius:50%;border:2px solid var(--accent2);background:transparent;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:transparent" ' +
          'title="Marcar como completada">✓</button>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:13px;font-weight:600;color:#f1f5f9">' + esc(t.title) + '</div>' +
          (t.notes ? '<div style="font-size:12px;color:var(--muted);margin-top:2px">' + esc(t.notes.slice(0, 100)) + '</div>' : '') +
          (t.due ? '<div style="font-size:11px;color:' + (isOverdue ? 'var(--red)' : 'var(--muted)') + ';margin-top:3px">' +
            (isOverdue ? '⚠ Vencida: ' : '📅 Vence: ') + new Date(t.due).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' }) +
          '</div>' : '') +
        '</div>' +
        '<button data-account="' + esc(account) + '" data-id="' + esc(t.id) + '" onclick="deleteGTask(this.dataset.account,this.dataset.id,this)" ' +
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

// ── WhatsApp chat helpers ─────────────────────────────────────────────────
function onChatChange(phone) {
  const label = document.getElementById('wa-active-contact');
  if (label && phone) label.textContent = phone.slice(-4).padStart(phone.length, '*');
  toggleChatPicker(false);
  loadChatHistory(phone);
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function onFileSelected(input) {
  const preview = document.getElementById('wa-file-preview');
  if (!preview) return;
  if (input.files && input.files[0]) {
    preview.style.display = 'flex';
    preview.innerHTML =
      '📎 <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      esc(input.files[0].name) + '</span>' +
      '<span class="wa-file-preview-x" onclick="clearFileInput()">✕</span>';
  } else {
    preview.style.display = 'none';
    preview.innerHTML = '';
  }
}

function clearFileInput() {
  const input = document.getElementById('send-image');
  if (input) input.value = '';
  const preview = document.getElementById('wa-file-preview');
  if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Close pickers on outside click ────────────────────────────────────────
document.addEventListener('click', (e) => {
  const picker = document.getElementById('wa-chat-picker');
  const switchBtn = document.getElementById('wa-switch-btn');
  if (picker && picker.style.display !== 'none' && !picker.contains(e.target) && e.target !== switchBtn) {
    picker.style.display = 'none';
  }
});

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
