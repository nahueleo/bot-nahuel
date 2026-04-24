/**
 * Herramientas de calendario en formato OpenAI/Groq (function calling).
 */

export const toolDeclarations = [
  {
    type: 'function',
    function: {
      name: 'list_calendars',
      description:
        'Lista todos los calendarios disponibles del usuario, de todas sus cuentas conectadas. ' +
        'Usar antes de crear eventos para saber en qué calendario agendar.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_events',
      description:
        'Obtiene los eventos de un calendario en un rango de fechas. ' +
        'Usar para mostrar la agenda del usuario o verificar disponibilidad.',
      parameters: {
        type: 'object',
        properties: {
          account_name: {
            type: 'string',
            description: 'Nombre de la cuenta (ej: "personal", "trabajo"). Obtenido de list_calendars.',
          },
          calendar_id: {
            type: 'string',
            description: 'ID del calendario (ej: "primary" o el email).',
          },
          date_from: {
            type: 'string',
            description: 'Fecha/hora inicio ISO 8601. Ej: "2025-04-23T00:00:00-03:00"',
          },
          date_to: {
            type: 'string',
            description: 'Fecha/hora fin ISO 8601.',
          },
        },
        required: ['account_name', 'calendar_id', 'date_from', 'date_to'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'create_event',
      description:
        'Crea un nuevo evento o reunión en un calendario. ' +
        'Siempre confirmar los detalles con el usuario antes de crear.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          calendar_id:  { type: 'string', description: 'ID del calendario.' },
          summary:      { type: 'string', description: 'Título del evento.' },
          start:        { type: 'string', description: 'Inicio ISO 8601.' },
          end:          { type: 'string', description: 'Fin ISO 8601.' },
          description:  { type: 'string', description: 'Descripción opcional.' },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Emails de los invitados.',
          },
          location:  { type: 'string', description: 'Lugar del evento.' },
          time_zone: { type: 'string', description: 'Zona horaria. Default: America/Argentina/Buenos_Aires' },
        },
        required: ['account_name', 'calendar_id', 'summary', 'start', 'end'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'find_free_slots',
      description:
        'Busca horarios libres en un calendario. ' +
        'Útil cuando el usuario pregunta cuándo tiene disponibilidad.',
      parameters: {
        type: 'object',
        properties: {
          account_name:     { type: 'string', description: 'Nombre de la cuenta.' },
          calendar_id:      { type: 'string', description: 'ID del calendario.' },
          date_from:        { type: 'string', description: 'Inicio del rango ISO 8601.' },
          date_to:          { type: 'string', description: 'Fin del rango ISO 8601.' },
          duration_minutes: { type: 'number', description: 'Duración en minutos. Default: 60' },
        },
        required: ['account_name', 'calendar_id', 'date_from', 'date_to'],
      },
    },
  },
];
