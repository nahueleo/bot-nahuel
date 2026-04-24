import OpenAI from 'openai';
import { config } from '../config/index.js';
import { toolDeclarations } from './tools.js';
import { listAllCalendars, getEvents, createEvent, findFreeSlots, updateEvent, deleteEvent, createRecurringEvent, searchEvents } from '../calendar/client.js';
import { scheduleReminder } from '../redis/reminders.js';
import { getTemplate, listTemplates } from '../calendar/templates.js';
import { searchEmails, getEmail, markAsRead, trashEmail, getUnreadCount } from '../gmail/client.js';
import { listTaskLists, getTasks, createTask, updateTask, completeTask, deleteTask } from '../tasks/client.js';

const openai = new OpenAI({
  apiKey: config.openrouter.apiKey,
  baseURL: 'https://openrouter.ai/api/v1',
});

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
- ERRORES DE AUTENTICACIÓN: Si un tool retorna un objeto con "auth_required: true", significa que la cuenta de Google no está conectada. Respondé EXACTAMENTE con este formato (reemplazando los datos del resultado): "La cuenta '[nombre]' no está conectada. Abrí este link para autenticarla: [auth_url]". Mandá el link tal cual, sin acortarlo ni modificarlo. No prometas resolver vos mismo el problema.
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

    return { error: msg };
  }
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
  const cleanHistory = sanitizeHistory(rawHistory);

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
          image_url: { url: `data:${imageContent.mimeType};base64,${imageContent.base64}` },
        },
        { type: 'text', text: userMessage },
      ]
    : userMessage;

  const messages = [
    { role: 'system', content: buildSystemContent() },
    ...cleanHistory,
    { role: 'user', content: userContent },
  ];

  const MAX_LOOPS = 5;
  let loops = 0;
  let currentMessages = [...messages];

  while (loops <= MAX_LOOPS) {
    console.log(`[ai] loop ${loops}  msgs_en_contexto=${currentMessages.length}`);
    let response;
    try {
      response = await openai.chat.completions.create({
        model:       'anthropic/claude-3-haiku',
        messages:    currentMessages,
        tools:       toolDeclarations,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens:  1024,
      });
    } catch (err) {
      console.error('[ai] Error en request de OpenRouter:', err.message || err.code || 'UNKNOWN');
      if (err.response?.status) {
        console.error('[ai] OpenRouter HTTP status:', err.response.status);
      }
      if (err.error) {
        console.error('[ai] OpenRouter body error:', JSON.stringify(err.error).slice(0, 1000));
        // Dump first few messages of context to help diagnose malformed history
        console.error('[ai] Primeros 3 msgs enviados:', JSON.stringify(currentMessages.slice(1, 4)).slice(0, 800));
      } else if (err.response?.data) {
        console.error('[ai] OpenRouter body data:', JSON.stringify(err.response.data).slice(0, 1000));
      } else {
        console.error('[ai] OpenRouter error object:', err);
      }
      throw err;
    }

    const choice = response.choices[0];
    const assistantMsg = choice.message;
    const finishReason = choice.finish_reason;
    console.log(`[ai] respuesta  finish_reason=${finishReason}  tool_calls=${assistantMsg.tool_calls?.length ?? 0}  tokens=${response.usage?.total_tokens ?? '?'}`);
    currentMessages.push(assistantMsg);

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
        return {
          role:         'tool',
          tool_call_id: tc.id,
          content:      JSON.stringify(result),
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
  const raw = currentMessages.slice(1); // quitar system message
  if (!imageContent) return raw;

  // El mensaje del usuario con imagen está en la posición cleanHistoryLength
  return [
    ...raw.slice(0, cleanHistoryLength),
    { role: 'user', content: userMessage },
    ...raw.slice(cleanHistoryLength + 1),
  ];
}
