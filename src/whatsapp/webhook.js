import { Router } from 'express';
import crypto from 'crypto';
import { config } from '../config/index.js';
import { processMessage } from '../ai/claude.js';
import { getHistory, setHistory, clearHistory, logMessage } from '../conversation/store.js';
import { sendWhatsAppMessage, downloadMedia } from './api.js';
import { transcribeAudio } from '../ai/transcribe.js';
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

  const from = msg.from; // número del remitente
  const fromTag = from.slice(-4).padStart(from.length, '*');
  const t0 = Date.now();

  let text;
  let imageContent = null; // { base64, mimeType } — solo para la llamada a Claude, no se guarda en historial

  if (msg.type === 'text') {
    text = msg.text?.body?.trim();
    if (!text) return;
    console.log(`[webhook] Texto de: ${fromTag}  "${text.slice(0, 60)}"`);

  } else if (msg.type === 'image') {
    const mediaId = msg.image?.id;
    if (!mediaId) return;
    const caption = msg.image?.caption?.trim() || '';
    console.log(`[webhook] Imagen de: ${fromTag}  caption="${caption.slice(0, 60)}"`);

    try {
      const { buffer, mimeType } = await downloadMedia(mediaId);
      // Normalizamos el mime type para el content type de la imagen
      const cleanMime = mimeType.split(';')[0].trim();
      imageContent = { base64: buffer.toString('base64'), mimeType: cleanMime };
      text = caption || 'Describí esta imagen';
    } catch (err) {
      console.error('[webhook] Error descargando imagen:', err.message);
      await sendWhatsAppMessage(from, 'No pude procesar la imagen. Intentá de nuevo.');
      return;
    }

  } else if (msg.type === 'audio') {
    const mediaId = msg.audio?.id;
    if (!mediaId) return;
    console.log(`[webhook] Audio de: ${fromTag}`);

    try {
      const { buffer, mimeType } = await downloadMedia(mediaId);
      text = await transcribeAudio(buffer, mimeType);
      if (!text) {
        await sendWhatsAppMessage(from, 'No pude entender el audio. Intentá hablar más claro o escribir tu mensaje.');
        return;
      }
      console.log(`[webhook] Audio transcripto: "${text.slice(0, 80)}"`);
    } catch (err) {
      console.error('[webhook] Error procesando audio:', err.message);
      await sendWhatsAppMessage(from, 'No pude procesar el audio. Intentá de nuevo.');
      return;
    }

  } else {
    console.log(`[webhook] Tipo de mensaje ignorado: ${msg.type}`);
    return;
  }

  // Comando de reset: limpiar historial de conversación
  if (text.toLowerCase() === 'reset' || text.toLowerCase() === 'reiniciar') {
    await clearHistory(from);
    console.log(`[webhook] Reset historial para ${fromTag}`);
    await sendWhatsAppMessage(from, '✅ Historial limpiado. ¡Empezamos de cero!');
    return;
  }

  // Obtener historial previo
  const history = await getHistory(from);

  // Procesar con Claude
  let reply;
  let updatedHistory;

  try {
    ({ reply, updatedHistory } = await processMessage(text, history, imageContent));
  } catch (err) {
    console.error(`[webhook] Error generando respuesta (${Date.now() - t0}ms):`, err.message || err.code || err);
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
      : 'Hubo un error al procesar tu mensaje. Intentá nuevamente en unos instantes.';

    console.log(`[webhook] Enviando fallback de error a ${fromTag}`);
    await sendWhatsAppMessage(from, fallbackMessage);
    return;
  }

  console.log(`[webhook] Respuesta generada en ${Date.now() - t0}ms  largo=${reply.length} chars`);

  // Guardar el historial completo de forma atómica para evitar cortes en pares tool_use/tool_result
  await setHistory(from, updatedHistory);

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
    console.log(`[webhook] Enviando respuesta en ${chunks.length} partes a ${fromTag}`);
    for (const chunk of chunks) {
      await sendWhatsAppMessage(from, chunk);
    }
  } else {
    console.log(`[webhook] Enviando respuesta a ${fromTag}`);
    await sendWhatsAppMessage(from, reply);
  }
  console.log(`[webhook] Flujo completo en ${Date.now() - t0}ms`);
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
