import { keyManager } from './key-manager.js';
import { config } from '../config/index.js';
import { selectTools } from './tools.js';
import { classifyIntent } from './intent.js';
import { listAllCalendars, getEvents, createEvent, findFreeSlots, updateEvent, deleteEvent, createRecurringEvent, searchEvents } from '../calendar/client.js';
import { scheduleReminder } from '../redis/reminders.js';
import { getTemplate, listTemplates } from '../calendar/templates.js';
import { searchEmails, getEmail, markAsRead, trashEmail, getUnreadCount } from '../gmail/client.js';
import { listTaskLists, getTasks, createTask, updateTask, completeTask, deleteTask } from '../tasks/client.js';


function buildSystemContent() {
  const nowART = new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `Sos un asistente personal de productividad que gestiona el calendario, el correo y las tareas del usuario vía WhatsApp.

📅 CALENDARIO:
- Crear eventos únicos o recurrentes
- Ver agenda por rango de fechas
- Editar y eliminar eventos
- Buscar eventos por texto
- Programar recordatorios automáticos
- Usar plantillas: standup, reunion_equipo, revision_mensual, entrevista, presentacion, capacitacion

📧 GMAIL:
- Ver cuántos emails no leídos hay ("¿cuántos mails tengo sin leer?")
- Buscar emails por remitente, asunto, fecha o estado
- Leer el contenido completo de un email
- Marcar emails como leídos
- Mover emails a la papelera

✅ GOOGLE TASKS:
- Listar tareas pendientes y listas de tareas
- Crear nuevas tareas (con título, notas y fecha de vencimiento opcional)
- Actualizar tareas existentes
- Marcar tareas como completadas
- Eliminar tareas

Reglas importantes:
- Respondé siempre en español.
- Antes de crear, modificar o eliminar cualquier cosa, mostrá un resumen y pedí confirmación explícita. Excepción: acciones de solo lectura (buscar, listar, leer) no necesitan confirmación.
- Para emails: nunca expongas el cuerpo completo si es muy largo; resumí el contenido en 2-3 líneas.
- Para tareas: si el usuario dice "anotá", "recordame", "tengo que hacer", interpretá eso como crear una tarea.
- Cuando muestres fechas, usá formato legible: "martes 23 de abril a las 15:00".
- Si el usuario dice "mañana", "próximo lunes", etc., calculá la fecha real. Ahora mismo en Argentina es: ${nowART}.
- Zona horaria del usuario: America/Argentina/Buenos_Aires (UTC-3). IMPORTANTE: cuando recibas fechas con offset como "T10:20:00Z" o "T10:20:00-03:00", siempre convertílas a la hora local del usuario antes de mostrarlas.
- Mantené las respuestas concisas para WhatsApp (máximo 3-4 párrafos cortos).
- Si el usuario escribe "reset" o "reiniciar", indicale que puede escribir ese comando para limpiar el historial.
- ERRORES DE AUTENTICACIÓN: Si un tool retorna un objeto con "auth_required: true", significa que la cuenta de Google no está conectada o necesita reautorizarse (por ejemplo, para acceder a Tasks o Gmail que fueron agregados después). Respondé EXACTAMENTE con este formato (reemplazando los datos del resultado): "La cuenta '[nombre]' necesita autorizarse. Abrí este link: [auth_url]". Mandá el link tal cual, sin acortarlo ni modificarlo. No prometas resolver vos mismo el problema.
- ERRORES GENERALES: Si un tool retorna { error: "..." }, reportá el problema al usuario de forma clara y concisa. No inventes soluciones que no podés ejecutar.`;
}

/**
 * Ejecuta la tool solicitada por el modelo.
 */
async function executeTool(name, args) {
  const argsSummary = JSON.stringify(args).slice(0, 120);
  console.log(`[ai:tool] → ${name}  args=${argsSummary}`);
  const t0 = Date.now();
  try {
    switch (name) {
      case 'list_calendars':
        return { calendars: await listAllCalendars() };

      case 'get_events':
        return { events: await getEvents(args.account_name, args.calendar_id, args.date_from, args.date_to) };

      case 'create_event':
        return { event: await createEvent(args.account_name, args.calendar_id, {
          summary: args.summary, start: args.start, end: args.end,
          description: args.description, attendees: args.attendees,
          location: args.location, timeZone: args.time_zone,
        }) };

      case 'find_free_slots':
        return { slots: await findFreeSlots(
          args.account_name, args.calendar_id,
          args.date_from, args.date_to, args.duration_minutes || 60,
        ) };

      case 'update_event':
        return { event: await updateEvent(args.account_name, args.calendar_id, args.event_id, {
          summary: args.summary, start: args.start, end: args.end,
          description: args.description, attendees: args.attendees,
          location: args.location, timeZone: args.time_zone,
        }) };

      case 'delete_event':
        return { deleted: await deleteEvent(args.account_name, args.calendar_id, args.event_id) };

      case 'create_recurring_event':
        return { event: await createRecurringEvent(args.account_name, args.calendar_id, {
          summary: args.summary, start: args.start, end: args.end,
          frequency: args.frequency, interval: args.interval, byDay: args.by_day,
          until: args.until, count: args.count,
          description: args.description, attendees: args.attendees,
          location: args.location, timeZone: args.time_zone,
        }) };

      case 'search_events':
        return { events: await searchEvents(args.account_name, args.calendar_id, args.query, args.date_from, args.date_to) };

      case 'schedule_reminder':
        const reminderTime = new Date(args.reminder_time);
        await scheduleReminder(args.event_id, args.phone_number, reminderTime, args.message);
        return { scheduled: true, reminderTime: reminderTime.toISOString() };

      // ─── Gmail ──────────────────────────────────────────────────────────────────

      case 'search_emails':
        return { emails: await searchEmails(args.account_name, args.query || '', args.max_results || 10) };

      case 'get_email':
        return { email: await getEmail(args.account_name, args.message_id) };

      case 'mark_email_as_read':
        return await markAsRead(args.account_name, args.message_id);

      case 'get_unread_count':
        return await getUnreadCount(args.account_name);

      case 'trash_email':
        return await trashEmail(args.account_name, args.message_id);

      // ─── Google Tasks ────────────────────────────────────────────────────────────

      case 'list_task_lists':
        return { taskLists: await listTaskLists(args.account_name) };

      case 'get_tasks':
        return { tasks: await getTasks(args.account_name, args.task_list_id || '@default', args.show_completed || false) };

      case 'create_task':
        return { task: await createTask(args.account_name, args.task_list_id || '@default', {
          title: args.title,
          notes: args.notes,
          due:   args.due,
        }) };

      case 'update_task':
        return { task: await updateTask(args.account_name, args.task_list_id || '@default', args.task_id, {
          title: args.title,
          notes: args.notes,
          due:   args.due,
        }) };

      case 'complete_task':
        return await completeTask(args.account_name, args.task_list_id || '@default', args.task_id);

      case 'delete_task':
        return await deleteTask(args.account_name, args.task_list_id || '@default', args.task_id);

      // ─── Plantillas ──────────────────────────────────────────────────────────────

      case 'create_event_from_template':
        const template = getTemplate(args.template_name);
        if (!template) {
          return { error: `Plantilla "${args.template_name}" no encontrada. Plantillas disponibles: ${listTemplates().map(t => t.name).join(', ')}` };
        }

        // Combinar template con datos personalizados
        const eventData = {
          summary: args.summary || template.summary,
          start: args.start,
          end: args.end || new Date(new Date(args.start).getTime() + template.duration * 60000).toISOString(),
          description: args.description || template.description,
          location: args.location || template.location,
          attendees: args.attendees || template.attendees,
          timeZone: args.time_zone,
        };

        return { event: await createEvent(args.account_name, args.calendar_id, eventData) };

      default:
        return { error: `Tool desconocida: ${name}` };
    }
  } catch (err) {
    const msg = err.message || 'Error desconocido';
    console.error(`[ai:tool] ✗ ${name} falló en ${Date.now() - t0}ms:`, msg.slice(0, 200));

    // Enrich auth errors with a clickable link so the model can send it via WhatsApp
    const accountMatch = msg.match(/Autenticá primero en ([^\s"]+)/);
    if (accountMatch) {
      const path = accountMatch[1]; // e.g. /auth/google?account=trabajo
      const fullUrl = `${config.publicUrl}${path}`;
      return {
        error: msg,
        auth_required: true,
        auth_url: fullUrl,
      };
    }

    // Detect Google API 403 scope errors — token exists but lacks required permissions
    // (e.g. tasks scope added after initial auth, or gmail scope missing).
    const httpStatus = err.status ?? err.code ?? err.response?.status;
    const isPermissionError = httpStatus === 403 ||
      msg.toLowerCase().includes('insufficient') ||
      msg.toLowerCase().includes('permission_denied');

    if (isPermissionError && args.account_name) {
      const path = `/auth/google?account=${encodeURIComponent(args.account_name)}`;
      const fullUrl = `${config.publicUrl}${path}`;
      console.warn(`[ai:tool] 403 scope error for account "${args.account_name}" — needs re-auth`);
      return {
        error: `La cuenta "${args.account_name}" necesita reautorizarse para acceder a esta función.`,
        auth_required: true,
        auth_url: fullUrl,
      };
    }

    return { error: msg };
  }
}

// Token budget para el prompt completo (sistema + tools + historial + mensaje actual).
// Con tool routing, las tools seleccionadas son un subconjunto (~300-1000 tokens vs ~2500 full).
const PROMPT_TOKEN_BUDGET = 5500;

/**
 * Estimación burda de tokens: ~4 chars por token (conservador).
 */
function estimateTokens(messages) {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content);
    return sum + Math.ceil((content?.length || 0) / 4) + 4; // +4 overhead por mensaje
  }, 0);
}

/**
 * Recorta el historial desde el inicio (mensajes más antiguos) hasta que
 * los tokens estimados queden bajo PROMPT_TOKEN_BUDGET.
 * Siempre deja el primer mensaje como `user` para evitar tool_result huérfano.
 */
function trimToTokenBudget(systemMsg, history, userMsg) {
  let trimmed = [...history];
  while (trimmed.length > 0) {
    const total = estimateTokens([systemMsg, ...trimmed, userMsg]);
    if (total <= PROMPT_TOKEN_BUDGET) break;

    // Eliminar el mensaje más antiguo; si quedaría tool_result al inicio, eliminar también
    trimmed.shift();
    while (trimmed.length > 0 && trimmed[0].role !== 'user') trimmed.shift();
  }
  if (trimmed.length !== history.length) {
    console.warn(`[ai:budget] Historial recortado por tokens: ${history.length} → ${trimmed.length} msgs`);
  }
  return trimmed;
}

/**
 * Removes trailing incomplete agentic turns (tool results without a following
 * assistant text response, or assistant tool_calls without results).
 * Prevents "unexpected tool_use_id" errors when the previous request hit MAX_LOOPS.
 */
function sanitizeHistory(history) {
  let arr = [...history];
  const before = arr.length;

  // Strip leading non-user messages: happens when trimHistory cut the assistant(tool_calls)
  // off the front, leaving an orphaned tool_result as the first message.
  while (arr.length > 0 && arr[0].role !== 'user') {
    arr.shift();
  }

  // Strip trailing incomplete agentic turns: tool results without a following assistant
  // response (MAX_LOOPS scenario), or assistant with unresolved tool_calls.
  let changed = true;
  while (changed) {
    changed = false;
    while (arr.length > 0 && arr[arr.length - 1].role === 'tool') {
      arr.pop();
      changed = true;
    }
    while (arr.length > 0 && arr[arr.length - 1].role === 'assistant' && arr[arr.length - 1].tool_calls?.length > 0) {
      arr.pop();
      changed = true;
    }
  }

  if (arr.length !== before) {
    console.warn(`[ai:history] sanitize eliminó ${before - arr.length} msgs inválidos (${before} → ${arr.length})`);
  }
  return arr;
}

function normalizeMessageForProvider(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const normalized = { role: msg.role };
  if (msg.content !== undefined) normalized.content = msg.content;
  if (msg.name) normalized.name = msg.name;
  if (msg.tool_calls) {
    normalized.tool_calls = msg.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      },
    }));
  }
  if (msg.tool_call_id) normalized.tool_call_id = msg.tool_call_id;
  if (msg.type) normalized.type = msg.type;
  if (msg.image_url) normalized.image_url = msg.image_url;
  return normalized;
}

function normalizeHistoryMessages(history) {
  return history.map(normalizeMessageForProvider);
}

/**
 * Procesa un mensaje con Claude vía OpenRouter, ejecutando tools
 * en loop hasta obtener respuesta de texto final.
 *
 * @param {string} userMessage
 * @param {Array}  history       - Historial en formato OpenAI: [{ role, content }]
 * @param {{ base64: string, mimeType: string } | null} imageContent - Imagen opcional
 * @returns {{ reply: string, updatedHistory: Array }}
 */
export async function processMessage(userMessage, history, imageContent = null) {
  const t0 = Date.now();
  const rawHistory = history || [];

  // Sanitize history to remove any trailing incomplete agentic turns saved from a previous MAX_LOOPS scenario
  const cleanHistory = normalizeHistoryMessages(sanitizeHistory(rawHistory));

  console.log(`[ai] processMessage  historial=${cleanHistory.length} msgs  imagen=${imageContent ? 'sí' : 'no'}  texto="${userMessage.slice(0, 80)}"`);
  if (cleanHistory.length > 0) {
    const lastMsg = cleanHistory[cleanHistory.length - 1];
    console.log(`[ai] último msg historial: role=${lastMsg.role}  tool_calls=${lastMsg.tool_calls?.length ?? 0}`);
  }

  // Construir el contenido del mensaje del usuario
  // Si hay imagen, se pasa como image_url (formato OpenAI vision)
  const userContent = imageContent
    ? [
        {
          type: 'image_url',
          image_url: { url: imageContent.base64 },
        },
        { type: 'text', text: userMessage },
      ]
    : userMessage;

  const systemMsg = { role: 'system', content: buildSystemContent() };
  const userMsg   = { role: 'user', content: typeof userContent === 'string' ? userContent : JSON.stringify(userContent) };

  // Recortar historial si el prompt estimado supera el budget de tokens
  const budgetHistory = trimToTokenBudget(systemMsg, cleanHistory, userMsg);

  const messages = [
    systemMsg,
    ...budgetHistory,
    { role: 'user', content: userContent },
  ];

  // Select only the tools relevant to this message — avoids sending all 24 tool
  // schemas on every request (saves ~1500-2000 tokens per call).
  const domains = classifyIntent(userMessage);
  const selectedTools = selectTools(domains);
  const toolParams = selectedTools.length > 0
    ? { tools: selectedTools, tool_choice: 'auto' }
    : {};
  console.log(`[ai:intent] domains=[${domains.join(',')}]  tools=${selectedTools.length}/24`);

  const MAX_LOOPS = 5;
  let loops = 0;
  let currentMessages = [...messages];
  let triedWithoutImage = false;
  let triedWithoutTools = false;

  while (loops <= MAX_LOOPS) {
    console.log(`[ai] loop ${loops}  msgs_en_contexto=${currentMessages.length}`);
    let response;
    try {
      response = await keyManager.createCompletion({
        model:       'anthropic/claude-3-haiku',
        messages:    currentMessages,
        ...toolParams,
        temperature: 0.3,
        max_tokens:  1024,
        requireImageSupport: Boolean(imageContent),
      });
    } catch (err) {
      // ── 402 token limit: reintentar con contexto mínimo ──────────────────────
      const is402 = err.status === 402 || err.error?.code === 402;
      const limitMatch = (err.error?.message || err.message || '').match(/(\d+) > (\d+)/);
      const isImageFailure = imageContent && !triedWithoutImage && (
        err.status === 404 ||
        err.error?.code === 'invalid_image' ||
        /invalid(_|-)?image|image.*unsupported|unsupported.*image/i.test(err.message || '') ||
        /soporten entradas de imagen/i.test(err.message || '')
      );

      if (isImageFailure) {
        triedWithoutImage = true;
        console.warn('[ai:retry] Imagen no soportada por el proveedor actual o no hay proveedor de visión activo. Reintentando sin enviar la imagen.');
        currentMessages = [
          currentMessages[0],
          ...budgetHistory,
          { role: 'user', content: userMessage },
        ];
        imageContent = null;
        continue;
      }

      // ── 400 sin body: provider rechaza tool history — reintentar sin tool msgs ──
      const is400NoBody = err.status === 400 && !err.error && !err.error?.message;
      if (is400NoBody && !triedWithoutTools) {
        triedWithoutTools = true;
        console.warn('[ai:retry] 400 sin body — probablemente incompatibilidad de tool history. Reintentando con historial limpio de tools.');
        const stripped = currentMessages
          .filter(m => m.role !== 'tool')
          .map(m => {
            if (m.tool_calls?.length) {
              const { tool_calls, ...rest } = m;   // eslint-disable-line no-unused-vars
              return { ...rest, content: rest.content || '' };
            }
            return m;
          });
        currentMessages = stripped;
        continue;
      }

      if (is402 && limitMatch) {
        const [, used, limit] = limitMatch;
        console.warn(`[ai:retry] 402 token limit (${used} > ${limit}). Reintentando con contexto mínimo.`);
        // Mantener solo system + último mensaje de usuario (sin historial)
        const systemMessage = currentMessages[0];
        const lastUserMsg   = [...currentMessages].reverse().find(m => m.role === 'user');
        const minimalCtx    = lastUserMsg ? [systemMessage, lastUserMsg] : [systemMessage];
        try {
          response = await keyManager.createCompletion({
            model:       'anthropic/claude-3-haiku',
            messages:    minimalCtx,
            ...toolParams,
            temperature: 0.3,
            max_tokens:  1024,
          });
          currentMessages = minimalCtx;
          console.warn('[ai:retry] ✓ Respuesta OK con contexto mínimo (historial descartado).');
        } catch (retryErr) {
          console.error('[ai:retry] ✗ Falló el reintento:', retryErr.message || retryErr.error?.message);
          throw retryErr;
        }
      } else {
        console.error('[ai] Error en request de OpenRouter:', err.message || err.code || 'UNKNOWN');
        if (err.error) {
          console.error('[ai] OpenRouter body error:', JSON.stringify(err.error).slice(0, 1000));
          console.error('[ai] Primeros 3 msgs enviados:', JSON.stringify(currentMessages.slice(1, 4)).slice(0, 800));
        } else if (err.response?.data) {
          console.error('[ai] OpenRouter body data:', JSON.stringify(err.response.data).slice(0, 1000));
        } else {
          console.error('[ai] OpenRouter error object:', err);
        }
        throw err;
      }
    }

    const choice = response.choices[0];
    const assistantMsg = choice.message;
    const finishReason = choice.finish_reason;
    console.log(`[ai] respuesta  finish_reason=${finishReason}  tool_calls=${assistantMsg.tool_calls?.length ?? 0}  tokens=${response.usage?.total_tokens ?? '?'}`);
    currentMessages.push(normalizeMessageForProvider(assistantMsg));

    // Sin tool calls → tenemos la respuesta final
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const reply = assistantMsg.content?.trim() || 'No pude generar una respuesta. Intentá de nuevo.';
      const updatedHistory = buildUpdatedHistory(currentMessages, cleanHistory.length, imageContent, userMessage);
      console.log(`[ai] ✓ respuesta final en ${Date.now() - t0}ms  largo=${reply.length}  historial_nuevo=${updatedHistory.length}`);
      return { reply, updatedHistory };
    }

    // Ejecutar todas las tools en paralelo
    loops++;
    const toolNames = assistantMsg.tool_calls.map(tc => tc.function.name).join(', ');
    console.log(`[ai] ejecutando ${assistantMsg.tool_calls.length} tool(s): ${toolNames}`);
    const toolResults = await Promise.all(
      assistantMsg.tool_calls.map(async (tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* noop */ }
        const result = await executeTool(tc.function.name, args);
        const resultSummary = JSON.stringify(result).slice(0, 100);
        console.log(`[ai:tool] ✓ ${tc.function.name}  id=${tc.id.slice(-8)}  result=${resultSummary}`);

        // Truncar resultados grandes para no explotar el contexto (ej: cuerpos de email completos)
        const MAX_TOOL_RESULT_CHARS = 3000;
        let content = JSON.stringify(result);
        if (content.length > MAX_TOOL_RESULT_CHARS) {
          console.warn(`[ai:tool] Resultado truncado: ${content.length} → ${MAX_TOOL_RESULT_CHARS} chars (${tc.function.name})`);
          content = content.slice(0, MAX_TOOL_RESULT_CHARS) + '... [truncado por límite de tokens]';
        }

        return {
          role:         'tool',
          tool_call_id: tc.id,
          content,
        };
      }),
    );

    currentMessages.push(...toolResults);
  }

  // Fallback si se alcanza el límite de loops
  // Push a final assistant message so the history doesn't end with tool messages,
  // which would cause "unexpected tool_use_id" errors on the next request.
  console.warn(`[ai] MAX_LOOPS alcanzado (${MAX_LOOPS}) en ${Date.now() - t0}ms`);
  const fallbackReply = 'Alcancé el límite de operaciones. Intentá con una pregunta más simple.';
  currentMessages.push({ role: 'assistant', content: fallbackReply });
  return {
    reply:          fallbackReply,
    updatedHistory: buildUpdatedHistory(currentMessages, cleanHistory.length, imageContent, userMessage),
  };
}

/**
 * Construye el historial a guardar en Redis, reemplazando el mensaje del usuario
 * con imagen (base64) por una versión texto-only para evitar inflar el almacenamiento.
 */
function buildUpdatedHistory(currentMessages, cleanHistoryLength, imageContent, userMessage) {
  const raw = currentMessages.slice(1).map(normalizeMessageForProvider); // quitar system message
  if (!imageContent) return raw;

  // El mensaje del usuario con imagen está en la posición cleanHistoryLength
  return [
    ...raw.slice(0, cleanHistoryLength),
    { role: 'user', content: userMessage },
    ...raw.slice(cleanHistoryLength + 1),
  ];
}
