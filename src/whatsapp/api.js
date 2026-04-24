import { config } from '../config/index.js';

// URL base de WhatsApp Cloud API — dominio fijo, no aceptamos URLs de usuario
const WA_API_BASE = 'https://graph.facebook.com/v19.0';

/**
 * Normaliza números argentinos al formato que acepta la WhatsApp Cloud API.
 *
 * WhatsApp entrega números argentinos en el webhook en formato E.164:
 *   549 + área(3) + número(7)  →  ej: 5493517452392
 *
 * Pero la API de envío (y la lista de teléfonos de prueba) usa el formato
 * internacional "antiguo" con prefijo 15:
 *   54 + área(3) + 15 + número(7)  →  ej: 54351157452392
 *
 * Referencia: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 *
 * @param {string} phone - Número tal como viene del webhook
 * @returns {string}     - Número normalizado para envío
 */
function normalizePhoneNumber(phone) {
  // Argentina E.164 móvil: 549 + área(3 dígitos) + número(7 dígitos) = 13 dígitos
  const arMobile = phone.match(/^549(\d{3})(\d{7})$/);
  if (arMobile) {
    return `54${arMobile[1]}15${arMobile[2]}`;
  }
  return phone;
}

/**
 * Envía un mensaje de texto por WhatsApp.
 * @param {string} to      - Número destino en formato internacional (ej: "549XXXXXXXXXX")
 * @param {string} message - Texto del mensaje
 */
export async function sendWhatsAppMessage(to, message) {
  // Validación básica del número de destino (solo dígitos, 7-20 chars)
  if (!/^\d{7,20}$/.test(to)) {
    throw new Error(`Número de destino inválido: ${to}`);
  }

  // Normalizar al formato que acepta la API de envío
  const normalizedTo = normalizePhoneNumber(to);

  const url = `${WA_API_BASE}/${config.whatsapp.phoneNumberId}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: normalizedTo,
    type: 'text',
    text: { body: message },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    // No seguir redirecciones — URL es estática y conocida
    redirect: 'error',
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const errMsg = errBody?.error?.message || errBody?.error?.error_data?.details || JSON.stringify(errBody).slice(0, 200);
    console.error('[whatsapp] Error enviando mensaje. Status:', response.status, '|', errMsg);
    throw new Error(`WhatsApp API error: ${response.status} — ${errMsg}`);
  }

  const data = await response.json();
  console.log('[whatsapp] Mensaje enviado. ID:', data.messages?.[0]?.id);
  return data;
}
