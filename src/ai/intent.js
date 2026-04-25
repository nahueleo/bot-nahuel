/**
 * Lightweight intent classifier that maps a user message to the set of
 * tool domains needed to answer it — without making any LLM call.
 *
 * Returns an array of domain names: 'calendar', 'gmail', 'tasks'.
 * Returns [] for pure social/greeting messages (no tools needed).
 * Returns all three domains when intent is ambiguous (safe fallback).
 */

const DOMAIN_PATTERNS = {
  calendar: [
    /evento|reunión|reunion|cita|agenda|calendario/i,
    /mañana|hoy\b|semana|próximo|proximo|ayer/i,
    /standup|daily|meeting|schedule/i,
    /recordatorio|alarma|reminder/i,
    /horario|disponible|libre|slot/i,
    /agendar|programar|crear.*evento|agregar.*calendari/i,
    /ver.*agenda|qué.*tengo.*hoy|qué.*tengo.*mañana|que.*tengo.*hoy|que.*tengo.*mañana/i,
    /lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo/i,
    /enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre/i,
    /plantilla|entrevista|presentacion|capacitacion|standup/i,
    /fecha|hora\b|horario|turno/i,
    /repite|recurrente|cada semana|cada mes/i,
    /buscar.*evento|evento.*buscar|encontrar.*reunión/i,
  ],
  gmail: [
    /e?-?mail|correo|mails?\b/i,
    /bandeja|inbox|entrada/i,
    /no le[ií]d[ao]|unread|sin leer/i,
    /mandar.*correo|enviar.*correo|enviar.*mail/i,
    /asunto|adjunto|attachment/i,
    /newsletter|spam|basura/i,
    /leer.*correo|correo.*leer|ver.*correo/i,
    /cuántos.*mail|cuantos.*mail|cuántos.*correo|cuantos.*correo/i,
    /mensaje.*recib|recib.*mensaje/i,
    /papelera|archivar/i,
  ],
  tasks: [
    /\btarea|task\b/i,
    /pendiente|to[-\s]?do/i,
    /recordame|recuérdame|recordá\b/i,
    /tengo que hacer|hay que hacer|debo hacer/i,
    /anotá|anotame\b|anota\b/i,
    /lista de tareas|task list/i,
    /completar.*tarea|marcar.*completad/i,
    /qué.*falta|qué.*pendiente|que.*falta|que.*pendiente/i,
    /necesito hacer|tengo pendiente/i,
    /checklist|por hacer/i,
  ],
};

// Pure social messages that need zero tools
const SOCIAL_PATTERNS = [
  /^(hola|buenas|buenos días|buenos dias|buenas tardes|buenas noches|hey|hi|hello)[.!]?\s*$/i,
  /^(gracias|thanks|thank you|de nada)[.!]?\s*$/i,
  /^(dale|ok|okay|sí|si|no|perfecto|entendido|listo)[.!]?\s*$/i,
  /^cómo estás|^como estas|^cómo andás|^como andas/i,
  /^(qué sos|qué hacés|qué podés hacer|que podes hacer)\??/i,
];

/**
 * Classifies the user message into domains.
 *
 * @param {string} message
 * @returns {string[]} array of domain names ('calendar', 'gmail', 'tasks'),
 *                     empty array for pure greetings/social.
 */
export function classifyIntent(message) {
  const msg = (message || '').trim();

  const scores = { calendar: 0, gmail: 0, tasks: 0 };
  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    for (const p of patterns) {
      if (p.test(msg)) scores[domain]++;
    }
  }

  const matched = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .map(([domain]) => domain);

  if (matched.length > 0) return matched;

  // No domain keyword found — check if it's a pure social message
  if (SOCIAL_PATTERNS.some(p => p.test(msg))) return [];

  // Unknown intent → safe fallback: all domains
  return ['calendar', 'gmail', 'tasks'];
}
