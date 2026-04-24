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

  // ─── Gmail ────────────────────────────────────────────────────────────────────

  {
    type: 'function',
    function: {
      name: 'search_emails',
      description:
        'Busca emails en Gmail usando la sintaxis de búsqueda de Google. ' +
        'Útil para encontrar emails por remitente, asunto, fecha o estado (leído/no leído). ' +
        'Ejemplos de query: "is:unread", "from:juan@gmail.com", "subject:factura", "after:2025/04/01".',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta (ej: "trabajo", "personal").' },
          query:        { type: 'string', description: 'Query de búsqueda en formato Gmail. Vacío devuelve los más recientes.' },
          max_results:  { type: 'number', description: 'Máximo de emails a devolver (default: 10, máx: 20).' },
        },
        required: ['account_name'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_email',
      description:
        'Obtiene el contenido completo de un email por su ID. ' +
        'Usar después de search_emails cuando el usuario quiere leer un email específico.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          message_id:   { type: 'string', description: 'ID del mensaje (obtenido de search_emails).' },
        },
        required: ['account_name', 'message_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'mark_email_as_read',
      description: 'Marca un email como leído.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          message_id:   { type: 'string', description: 'ID del mensaje.' },
        },
        required: ['account_name', 'message_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_unread_count',
      description: 'Devuelve cuántos emails no leídos hay en la bandeja de entrada.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
        },
        required: ['account_name'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'trash_email',
      description: 'Mueve un email a la papelera.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          message_id:   { type: 'string', description: 'ID del mensaje.' },
        },
        required: ['account_name', 'message_id'],
      },
    },
  },

  // ─── Google Tasks ──────────────────────────────────────────────────────────────

  {
    type: 'function',
    function: {
      name: 'list_task_lists',
      description: 'Lista todas las listas de tareas del usuario en Google Tasks.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
        },
        required: ['account_name'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description:
        'Obtiene las tareas de una lista. ' +
        'Usar "@default" como task_list_id para la lista principal.',
      parameters: {
        type: 'object',
        properties: {
          account_name:   { type: 'string', description: 'Nombre de la cuenta.' },
          task_list_id:   { type: 'string', description: 'ID de la lista de tareas (default: "@default").' },
          show_completed: { type: 'boolean', description: 'Incluir tareas completadas (default: false).' },
        },
        required: ['account_name'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'create_task',
      description:
        'Crea una nueva tarea en Google Tasks. ' +
        'Ideal cuando el usuario dice "recordame hacer X", "anotá que tengo que...", etc.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          task_list_id: { type: 'string', description: 'ID de la lista (default: "@default").' },
          title:        { type: 'string', description: 'Título de la tarea.' },
          notes:        { type: 'string', description: 'Notas adicionales (opcional).' },
          due:          { type: 'string', description: 'Fecha de vencimiento ISO 8601 (opcional). Ej: "2025-04-25".' },
        },
        required: ['account_name', 'title'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Modifica el título, notas o fecha de vencimiento de una tarea existente.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          task_list_id: { type: 'string', description: 'ID de la lista (default: "@default").' },
          task_id:      { type: 'string', description: 'ID de la tarea (obtenido de get_tasks).' },
          title:        { type: 'string', description: 'Nuevo título.' },
          notes:        { type: 'string', description: 'Nuevas notas.' },
          due:          { type: 'string', description: 'Nueva fecha de vencimiento ISO 8601.' },
        },
        required: ['account_name', 'task_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'complete_task',
      description: 'Marca una tarea como completada.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          task_list_id: { type: 'string', description: 'ID de la lista (default: "@default").' },
          task_id:      { type: 'string', description: 'ID de la tarea.' },
        },
        required: ['account_name', 'task_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Elimina una tarea de Google Tasks.',
      parameters: {
        type: 'object',
        properties: {
          account_name: { type: 'string', description: 'Nombre de la cuenta.' },
          task_list_id: { type: 'string', description: 'ID de la lista (default: "@default").' },
          task_id:      { type: 'string', description: 'ID de la tarea.' },
        },
        required: ['account_name', 'task_id'],
      },
    },
  },

  // ─── Plantillas ────────────────────────────────────────────────────────────────

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
