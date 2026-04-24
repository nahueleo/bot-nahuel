import OpenAI from 'openai';
import { config } from '../config/index.js';
import { toolDeclarations } from './tools.js';
import { listAllCalendars, getEvents, createEvent, findFreeSlots, updateEvent, deleteEvent, createRecurringEvent, searchEvents } from '../calendar/client.js';
import { scheduleReminder } from '../redis/reminders.js';
import { getTemplate, listTemplates } from '../calendar/templates.js';

const openai = new OpenAI({
  apiKey: config.openrouter.apiKey,
  baseURL: 'https://openrouter.ai/api/v1',
});

const SYSTEM_CONTENT = `Sos un asistente personal de productividad que ayuda a gestionar el calendario vía WhatsApp.
Podés leer, crear, modificar y eliminar eventos en todos los calendarios del usuario (trabajo y personales). También podés crear eventos recurrentes para reuniones regulares, buscar eventos por palabras clave, programar recordatorios automáticos y usar plantillas predefinidas.

Funcionalidades disponibles:
- Crear eventos únicos o recurrentes
- Buscar eventos por texto (título/descripción)
- Editar y eliminar eventos existentes
- Programar recordatorios automáticos
- Usar plantillas: standup, reunion_equipo, revision_mensual, entrevista, presentacion, capacitacion

Reglas importantes:
- Respondé siempre en español.
- Antes de crear, modificar o eliminar un evento, mostrá un resumen y pedí confirmación explícita.
- Para eventos recurrentes, preguntá por la frecuencia (diaria, semanal, mensual) y duración.
- Ofrecé usar plantillas cuando el usuario mencione tipos comunes de reuniones.
- Sugerí recordatorios automáticos cuando sea apropiado (ej: "te recuerdo 15min antes").
- Cuando muestres fechas, usá formato legible: "martes 23 de abril a las 15:00".
- Si el usuario dice "mañana", "próximo lunes", etc., calculá la fecha real. Hoy es: ${new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.
- Zona horaria del usuario: America/Argentina/Buenos_Aires (UTC-3).
- Mantené las respuestas concisas para WhatsApp (máximo 3-4 párrafos cortos).
- Si el usuario escribe "reset" o "reiniciar", indicale que puede escribir ese comando para limpiar el historial.`;

/**
 * Ejecuta la tool solicitada por el modelo.
 */
async function executeTool(name, args) {
  console.log(`[ai] Ejecutando tool: ${name}`);
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
    console.error(`[ai] Error en tool "${name}":`, err.message?.slice(0, 100));
    return { error: err.message || 'Error desconocido' };
  }
}

/**
 * Procesa un mensaje con Groq (llama-3.3-70b-versatile), ejecutando tools
 * en loop hasta obtener respuesta de texto final.
 *
 * @param {string} userMessage
 * @param {Array}  history  - Historial en formato OpenAI: [{ role, content }]
 * @returns {{ reply: string, updatedHistory: Array }}
 */
export async function processMessage(userMessage, history) {
  // Sistema + historial previo + mensaje nuevo
  const messages = [
    { role: 'system', content: SYSTEM_CONTENT },
    ...(history || []),
    { role: 'user', content: userMessage },
  ];

  const MAX_LOOPS = 5;
  let loops = 0;
  let currentMessages = [...messages];

  while (loops <= MAX_LOOPS) {
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
      } else if (err.response?.data) {
        console.error('[ai] OpenRouter body data:', JSON.stringify(err.response.data).slice(0, 1000));
      } else {
        console.error('[ai] OpenRouter error object:', err);
      }
      throw err;
    }

    const assistantMsg = response.choices[0].message;
    currentMessages.push(assistantMsg);

    // Sin tool calls → tenemos la respuesta final
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const reply = assistantMsg.content?.trim() || 'No pude generar una respuesta. Intentá de nuevo.';
      // Devolver historial sin el mensaje de sistema (para no duplicarlo en cada llamada)
      const updatedHistory = currentMessages.slice(1);
      return { reply, updatedHistory };
    }

    // Ejecutar todas las tools en paralelo
    loops++;
    const toolResults = await Promise.all(
      assistantMsg.tool_calls.map(async (tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* noop */ }
        const result = await executeTool(tc.function.name, args);
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
  return {
    reply:          'Alcancé el límite de operaciones. Intentá con una pregunta más simple.',
    updatedHistory: currentMessages.slice(1),
  };
}
