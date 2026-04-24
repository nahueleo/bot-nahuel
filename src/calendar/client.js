import { google } from 'googleapis';
import { getAuthClient, listConnectedAccounts } from '../auth/google.js';

/**
 * Retorna un cliente de Google Calendar autenticado para una cuenta.
 */
async function getCalendarClient(accountName) {
  const auth = await getAuthClient(accountName);
  if (!auth) throw new Error(`Cuenta "${accountName}" no conectada. Abrí /auth/google?account=${accountName}`);
  return google.calendar({ version: 'v3', auth });
}

/**
 * Lista todos los calendarios de todas las cuentas conectadas.
 * @returns {Array<{ accountName, calendarId, summary, primary }>}
 */
export async function listAllCalendars() {
  const accounts = await listConnectedAccounts();
  if (accounts.length === 0) {
    throw new Error('No hay cuentas de Google conectadas. Visitá /auth/google?account=trabajo para conectar una.');
  }

  const results = [];

  for (const accountName of accounts) {
    try {
      const cal = await getCalendarClient(accountName);
      const { data } = await cal.calendarList.list();

      for (const item of data.items || []) {
        results.push({
          accountName,
          calendarId: item.id,
          summary: item.summary,
          primary: !!item.primary,
          accessRole: item.accessRole,
        });
      }
    } catch (err) {
      // Log sin exponer tokens ni datos sensibles
      console.error(`[calendar] Error listando calendarios para "${accountName}":`, err.code || 'UNKNOWN');
    }
  }

  return results;
}

/**
 * Obtiene eventos de un calendario en un rango de fechas.
 * @param {string} accountName - Nombre de la cuenta (ej: "trabajo")
 * @param {string} calendarId  - ID del calendario (ej: "primary" o email)
 * @param {string} dateFrom    - ISO 8601 (ej: "2025-04-23T00:00:00-03:00")
 * @param {string} dateTo      - ISO 8601
 * @returns {Array<{ id, summary, start, end, attendees, htmlLink }>}
 */
export async function getEvents(accountName, calendarId, dateFrom, dateTo) {
  const cal = await getCalendarClient(accountName);

  const { data } = await cal.events.list({
    calendarId,
    timeMin: new Date(dateFrom).toISOString(),
    timeMax: new Date(dateTo).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  return (data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || '(Sin título)',
    start: e.start?.dateTime || e.start?.date,
    end:   e.end?.dateTime   || e.end?.date,
    attendees: (e.attendees || []).map((a) => a.email),
    htmlLink: e.htmlLink,
    status: e.status,
  }));
}

/**
 * Crea un evento en un calendario.
 * @param {string} accountName
 * @param {string} calendarId
 * @param {{ summary, start, end, attendees?, description?, location? }} eventData
 * @returns {{ id, htmlLink, summary, start, end }}
 */
export async function createEvent(accountName, calendarId, eventData) {
  const cal = await getCalendarClient(accountName);

  // Construir el recurso del evento
  const resource = {
    summary:     eventData.summary,
    description: eventData.description || '',
    location:    eventData.location || '',
    start: {
      dateTime: new Date(eventData.start).toISOString(),
      timeZone: eventData.timeZone || 'America/Argentina/Buenos_Aires',
    },
    end: {
      dateTime: new Date(eventData.end).toISOString(),
      timeZone: eventData.timeZone || 'America/Argentina/Buenos_Aires',
    },
  };

  // Agregar invitados si se especificaron
  if (Array.isArray(eventData.attendees) && eventData.attendees.length > 0) {
    // Validar que los emails tengan formato básico (no confiar en input del usuario directo)
    const validEmails = eventData.attendees.filter((e) =>
      typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length < 200,
    );
    if (validEmails.length > 0) {
      resource.attendees = validEmails.map((email) => ({ email }));
    }
  }

  const { data } = await cal.events.insert({
    calendarId,
    resource,
    sendUpdates: 'all', // envía invitaciones a los attendees
  });

  console.log(`[calendar] Evento creado en "${accountName}/${calendarId}": ${data.id}`);

  return {
    id:      data.id,
    htmlLink: data.htmlLink,
    summary: data.summary,
    start:   data.start?.dateTime || data.start?.date,
    end:     data.end?.dateTime   || data.end?.date,
  };
}

/**
 * Busca slots libres en un calendario dado.
 * @param {string} accountName
 * @param {string} calendarId
 * @param {string} dateFrom  - ISO 8601
 * @param {string} dateTo    - ISO 8601
 * @param {number} durationMinutes - duración del slot buscado
 * @returns {Array<{ start, end }>} slots libres disponibles
 */
export async function findFreeSlots(accountName, calendarId, dateFrom, dateTo, durationMinutes = 60) {
  const cal = await getCalendarClient(accountName);

  const { data } = await cal.freebusy.query({
    requestBody: {
      timeMin: new Date(dateFrom).toISOString(),
      timeMax: new Date(dateTo).toISOString(),
      items: [{ id: calendarId }],
    },
  });

  const busyTimes = data.calendars?.[calendarId]?.busy || [];

  // Generar slots de trabajo: lunes a viernes, 9am a 7pm en zona Argentina
  const slots = [];
  const current = new Date(dateFrom);
  const end = new Date(dateTo);

  while (current < end) {
    const dayOfWeek = current.getDay(); // 0=Dom, 6=Sab

    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      // Día laboral: iterar de 9am a 7pm en bloques de durationMinutes
      const dayStart = new Date(current);
      dayStart.setHours(9, 0, 0, 0);
      const dayEnd = new Date(current);
      dayEnd.setHours(19, 0, 0, 0);

      let slotStart = new Date(dayStart);

      while (slotStart < dayEnd) {
        const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);
        if (slotEnd > dayEnd) break;

        // Verificar que el slot no choca con ningún período ocupado
        const isFree = !busyTimes.some((busy) => {
          const busyStart = new Date(busy.start);
          const busyEnd   = new Date(busy.end);
          return slotStart < busyEnd && slotEnd > busyStart;
        });

        if (isFree) {
          slots.push({
            start: slotStart.toISOString(),
            end:   slotEnd.toISOString(),
          });
        }

        slotStart = new Date(slotStart.getTime() + 30 * 60000); // avanzar 30 min
      }
    }

    current.setDate(current.getDate() + 1);
    current.setHours(0, 0, 0, 0);
  }

  // Retornar solo los primeros 10 slots para no abrumar a Claude
  return slots.slice(0, 10);
}
