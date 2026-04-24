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

  {
    type: 'function',
    function: {
      name: 'update_event',
      description:
        'Modifica un evento existente en un calendario. ' +
        'Usar cuando el usuario quiere cambiar fecha, hora, título, invitados, etc.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          calendar_id:  { type: 'string', description: 'ID del calendario.' },
          event_id:     { type: 'string', description: 'ID del evento a modificar (obtener de get_events).' },
          summary:      { type: 'string', description: 'Nuevo título del evento.' },
          start:        { type: 'string', description: 'Nueva fecha/hora inicio ISO 8601.' },
          end:          { type: 'string', description: 'Nueva fecha/hora fin ISO 8601.' },
          description:  { type: 'string', description: 'Nueva descripción.' },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nuevos emails de los invitados.',
          },
          location:  { type: 'string', description: 'Nuevo lugar del evento.' },
          time_zone: { type: 'string', description: 'Nueva zona horaria.' },
        },
        required: ['account_name', 'calendar_id', 'event_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'delete_event',
      description:
        'Elimina un evento de un calendario. ' +
        'Usar cuando el usuario quiere cancelar o eliminar una reunión.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          calendar_id:  { type: 'string', description: 'ID del calendario.' },
          event_id:     { type: 'string', description: 'ID del evento a eliminar (obtener de get_events).' },
        },
        required: ['account_name', 'calendar_id', 'event_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'create_recurring_event',
      description:
        'Crea un evento que se repite periódicamente (semanal, mensual, etc.). ' +
        'Útil para reuniones regulares como standups, revisiones mensuales, etc.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          calendar_id:  { type: 'string', description: 'ID del calendario.' },
          summary:      { type: 'string', description: 'Título del evento.' },
          start:        { type: 'string', description: 'Fecha/hora inicio primera ocurrencia ISO 8601.' },
          end:          { type: 'string', description: 'Fecha/hora fin primera ocurrencia ISO 8601.' },
          frequency:    { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'], description: 'Frecuencia de repetición.' },
          interval:     { type: 'number', description: 'Cada cuántas unidades repetir (ej: 2 = cada 2 semanas). Default: 1' },
          by_day: {
            type: 'array',
            items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] },
            description: 'Días específicos de la semana (solo para WEEKLY).',
          },
          until:        { type: 'string', description: 'Fecha hasta la que repetir ISO 8601.' },
          count:        { type: 'number', description: 'Número máximo de ocurrencias.' },
          description:  { type: 'string', description: 'Descripción opcional.' },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Emails de los invitados.',
          },
          location:  { type: 'string', description: 'Lugar del evento.' },
          time_zone: { type: 'string', description: 'Zona horaria.' },
        },
        required: ['account_name', 'calendar_id', 'summary', 'start', 'end', 'frequency'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'search_events',
      description:
        'Busca eventos por palabras clave en el título o descripción. ' +
        'Útil para encontrar reuniones específicas o eventos relacionados con un tema.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          calendar_id:  { type: 'string', description: 'ID del calendario.' },
          query:        { type: 'string', description: 'Texto a buscar en título/descripción.' },
          date_from:    { type: 'string', description: 'Inicio del rango de búsqueda ISO 8601.' },
          date_to:      { type: 'string', description: 'Fin del rango de búsqueda ISO 8601.' },
        },
        required: ['account_name', 'calendar_id', 'query', 'date_from', 'date_to'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'schedule_reminder',
      description:
        'Programa un recordatorio automático para un evento. ' +
        'El recordatorio se enviará por WhatsApp en el momento especificado.',
      parameters: {
        type: 'object',
        properties: {
          event_id:      { type: 'string', description: 'ID del evento para recordar.' },
          phone_number:  { type: 'string', description: 'Número de WhatsApp del destinatario.' },
          reminder_time: { type: 'string', description: 'Fecha/hora del recordatorio ISO 8601.' },
          message:       { type: 'string', description: 'Mensaje del recordatorio.' },
        },
        required: ['event_id', 'phone_number', 'reminder_time', 'message'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'create_event_from_template',
      description:
        'Crea un evento usando una plantilla predefinida (standup, reunión equipo, etc.). ' +
        'Más rápido que especificar todos los detalles manualmente.',
      parameters: {
        type: 'object',
        properties: {
          account_name:  { type: 'string', description: 'Nombre de la cuenta.' },
          calendar_id:   { type: 'string', description: 'ID del calendario.' },
          template_name: { type: 'string', description: 'Nombre de la plantilla (standup, reunion_equipo, revision_mensual, entrevista, presentacion, capacitacion).' },
          summary:       { type: 'string', description: 'Título personalizado (opcional, usa el de la plantilla si no se especifica).' },
          start:         { type: 'string', description: 'Fecha/hora inicio ISO 8601.' },
          end:           { type: 'string', description: 'Fecha/hora fin ISO 8601 (opcional, calcula duración de plantilla).' },
          description:   { type: 'string', description: 'Descripción personalizada (opcional).' },
          location:      { type: 'string', description: 'Lugar personalizado (opcional).' },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Emails de invitados.',
          },
          time_zone: { type: 'string', description: 'Zona horaria.' },
        },
        required: ['account_name', 'calendar_id', 'template_name', 'start'],
      },
    },
  },
];
