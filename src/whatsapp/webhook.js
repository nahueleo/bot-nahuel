import { Router } from 'express';
import crypto from 'crypto';
import { config } from '../config/index.js';
import { processMessage } from '../ai/claude.js';
import { getHistory, appendMessage, clearHistory, logMessage } from '../conversation/store.js';
import { sendWhatsAppMessage } from './api.js';
import { broadcastSSE } from '../dashboard/routes.js';

const router = Router();

/**
 * Verifica la firma HMAC-SHA256 que Meta envía en cada webhook.
 * Usa timingSafeEqual para prevenir timing attacks.
 *
 * @param {Buffer} rawBody     - Body crudo (antes del parsing JSON)
 * @param {string} signatureHeader - Valor del header X-Hub-Signature-256
 * @returns {boolean}
 */
function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = crypto
    .createHmac('sha256', config.whatsapp.appSecret)
    .update(rawBody)
    .digest('hex');

  const received = signatureHeader.slice('sha256='.length);

  // Comparación en tiempo constante — previene timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex'),
    );
  } catch {
    return false;
  }
}

// ─── GET /webhook — Verificación inicial de Meta ─────────────────────────────

router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('[webhook] Verificación de Meta exitosa.');
    return res.status(200).send(challenge);
  }

  console.warn('[webhook] Verificación de Meta fallida. Token incorrecto.');
  res.sendStatus(403);
});

// ─── POST /webhook — Mensajes entrantes ──────────────────────────────────────

router.post('/webhook', async (req, res) => {
  // 1. Verificar firma HMAC — rechazar inmediatamente si es inválida
  const signature = req.headers['x-hub-signature-256'];
  if (!verifySignature(req.rawBody, signature)) {
    console.warn('[webhook] Firma HMAC inválida — request rechazado.');
    return res.sendStatus(401);
  }

  // 2. Responder 200 a Meta de inmediato (tienen timeout de 20s)
  res.sendStatus(200);

  // 3. Procesar el mensaje en background (no bloquear la respuesta a Meta)
  try {
    await handleIncoming(req.body);
  } catch (err) {
    console.error('[webhook] Error procesando mensaje entrante:', err.message || err.code || 'UNKNOWN');
  }
});

/**
 * Extrae y procesa mensajes de texto de la estructura de webhook de WhatsApp.
 */
async function handleIncoming(body) {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  // Ignorar notificaciones de estado (delivered, read, etc.)
  if (value?.statuses) return;

  const messages = value?.messages;
  if (!messages || messages.length === 0) return;

  const msg = messages[0];

  // Solo procesar mensajes de texto por ahora
  if (msg.type !== 'text') {
    console.log(`[webhook] Tipo de mensaje ignorado: ${msg.type}`);
    return;
  }

  const from = msg.from; // número del remitente
  const text = msg.text?.body?.trim();

  if (!text) return;

  console.log(`[webhook] Mensaje recibido de: ${from.slice(-4).padStart(from.length, '*')}`); // ocultar número completo en logs

  // Comando de reset: limpiar historial de conversación
  if (text.toLowerCase() === 'reset' || text.toLowerCase() === 'reiniciar') {
    await clearHistory(from);
    await sendWhatsAppMessage(from, '✅ Historial limpiado. ¡Empezamos de cero!');
    return;
  }

  // Obtener historial previo
  const history = await getHistory(from);

  // Procesar con Claude
  let reply;
  let updatedHistory;

  try {
    ({ reply, updatedHistory } = await processMessage(text, history));
  } catch (err) {
    console.error('[webhook] Error generando respuesta:', err.message || err.code || err);
    if (err.error) {
      console.error('[webhook] Detalle OpenAI error:', JSON.stringify(err.error).slice(0, 1000));
    }
    if (err.response?.data) {
      console.error('[webhook] Detalle response data:', JSON.stringify(err.response.data).slice(0, 1000));
    }

    const errorText = String(err.message || err).toLowerCase();
    const isRateLimitError = errorText.includes('rate limit')
      || errorText.includes('rate_limit')
      || errorText.includes('tokens per day')
      || errorText.includes('rate_limit_exceeded');

    const fallbackMessage = isRateLimitError
      ? 'Estoy recibiendo muchos pedidos del servicio de IA en este momento. Probá de nuevo en unos minutos, por favor.'
      : 'Hubo un error al procesar tu mensaje. Intentá nuevamente en unos instantes.' + errorText.slice(0, 100);

    await sendWhatsAppMessage(from, fallbackMessage);
    return;
  }

  // Guardar el historial actualizado (incluye el mensaje del usuario y la respuesta de Claude)
  // Guardamos solo los últimos mensajes del historial actualizado
  for (const msg of updatedHistory.slice(history.length)) {
    await appendMessage(from, msg);
  }

  // Loguear para el dashboard y emitir por SSE en tiempo real
  await logMessage(from, text, reply, true);
  broadcastSSE('message', {
    from:      from.slice(-4).padStart(10, '*'),
    text:      text.slice(0, 200),
    response:  reply.slice(0, 300),
    timestamp: new Date().toISOString(),
  });

  // Enviar respuesta por WhatsApp
  // WhatsApp tiene límite de ~4096 caracteres por mensaje
  if (reply.length > 4000) {
    const chunks = splitMessage(reply, 4000);
    for (const chunk of chunks) {
      await sendWhatsAppMessage(from, chunk);
    }
  } else {
    await sendWhatsAppMessage(from, reply);
  }
}

/**
 * Divide un mensaje largo en partes respetando los saltos de línea.
 */
function splitMessage(text, maxLength) {
  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > maxLength) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks;
}

export default router;
