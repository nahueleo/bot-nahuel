/**
 * Plantillas predefinidas de eventos comunes.
 */
export const eventTemplates = {
  standup: {
    summary: 'Daily Standup',
    duration: 30, // minutos
    description: 'Reunión diaria de standup para revisar progreso y bloqueantes.',
    attendees: [],
    location: 'Sala de reuniones',
  },

  reunion_equipo: {
    summary: 'Reunión de Equipo',
    duration: 60,
    description: 'Reunión semanal del equipo para alinear objetivos y revisar progreso.',
    attendees: [],
    location: 'Sala de juntas',
  },

  revision_mensual: {
    summary: 'Revisión Mensual',
    duration: 90,
    description: 'Revisión mensual de objetivos, KPIs y planificación.',
    attendees: [],
    location: 'Sala de conferencias',
  },

  entrevista: {
    summary: 'Entrevista',
    duration: 60,
    description: 'Entrevista para posición abierta.',
    attendees: [],
    location: 'Oficina principal',
  },

  presentacion: {
    summary: 'Presentación',
    duration: 45,
    description: 'Presentación de proyecto o actualización.',
    attendees: [],
    location: 'Auditorio',
  },

  capacitacion: {
    summary: 'Capacitación',
    duration: 120,
    description: 'Sesión de capacitación o workshop.',
    attendees: [],
    location: 'Sala de training',
  },
};

/**
 * Obtiene una plantilla por nombre.
 * @param {string} templateName
 * @returns {object|null}
 */
export function getTemplate(templateName) {
  const normalizedName = templateName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return eventTemplates[normalizedName] || null;
}

/**
 * Lista todas las plantillas disponibles.
 * @returns {Array<{name, summary, duration, description}>}
 */
export function listTemplates() {
  return Object.entries(eventTemplates).map(([key, template]) => ({
    name: key,
    summary: template.summary,
    duration: template.duration,
    description: template.description,
  }));
}