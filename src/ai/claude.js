import Groq from 'groq-sdk';
import { config } from '../config/index.js';
import { toolDeclarations } from './tools.js';
import { listAllCalendars, getEvents, createEvent, findFreeSlots } from '../calendar/client.js';

const groq = new Groq({ apiKey: config.groq.apiKey });

const SYSTEM_CONTENT = `Sos un asistente personal de productividad que ayuda a gestionar el calendario vía WhatsApp.
Podés leer y crear eventos en todos los calendarios del usuario (trabajo y personales).

Reglas importantes:
- Respondé siempre en español.
- Antes de crear un evento, mostrá un resumen y pedí confirmación explícita.
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
    const response = await groq.chat.completions.create({
      model:       'llama-3.3-70b-versatile',
      messages:    currentMessages,
      tools:       toolDeclarations,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens:  1024,
    });

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
