import { Router } from 'express';
import { google } from 'googleapis';
import { config } from '../config/index.js';
import { getRedisClient } from '../redis/client.js';
import { sendWhatsAppMessage } from '../whatsapp/api.js';

const TOKEN_PREFIX = 'gtoken:';
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 días (el refresh_token es de larga duración)

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/tasks',
];

/**
 * Crea un cliente OAuth2 para una cuenta dada.
 */
export function createOAuth2Client() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

/**
 * Guarda los tokens OAuth de una cuenta en Redis.
 * Los tokens son sensibles: se guardan bajo clave con prefijo pero sin loguearlos nunca.
 */
export async function saveTokens(accountName, tokens) {
  const redis = await getRedisClient();
  await redis.set(
    `${TOKEN_PREFIX}${accountName}`,
    JSON.stringify(tokens),
    { EX: TOKEN_TTL },
  );
  console.log(`[auth] Tokens guardados para cuenta: ${accountName}`);
}

/**
 * Recupera los tokens OAuth de una cuenta.
 */
export async function getTokens(accountName) {
  const redis = await getRedisClient();
  const raw = await redis.get(`${TOKEN_PREFIX}${accountName}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lista todas las cuentas que tienen tokens guardados.
 */
export async function listConnectedAccounts() {
  const redis = await getRedisClient();
  const keys = await redis.keys(`${TOKEN_PREFIX}*`);
  return keys.map((k) => k.replace(TOKEN_PREFIX, ''));
}

/**
 * Devuelve un cliente OAuth2 autenticado para una cuenta.
 * Renueva el access_token automáticamente si expiró.
 */
export async function getAuthClient(accountName) {
  const tokens = await getTokens(accountName);
  if (!tokens) return null;

  const auth = createOAuth2Client();
  auth.setCredentials(tokens);

  // googleapis maneja el refresh automáticamente cuando configura el listener
  auth.on('tokens', async (newTokens) => {
    // Merge: preservar refresh_token si Google no lo retorna en el refresh
    const updated = { ...tokens, ...newTokens };
    await saveTokens(accountName, updated);
    // No loguear los tokens, solo confirmar renovación
    console.log(`[auth] Tokens renovados para cuenta: ${accountName}`);
  });

  return auth;
}

// ─── Router Express ───────────────────────────────────────────────────────────

const router = Router();

/**
 * GET /auth/google?account=trabajo
 * Inicia el flujo OAuth. El parámetro `account` es el nombre que le das a la cuenta
 * (ej: "trabajo", "personal"). Podés conectar todas las que quieras.
 */
router.get('/auth/google', (req, res) => {
  const account = req.query.account;

  // Validación: solo letras, números y guión bajo/medio (no confiar en input del usuario)
  if (!account || !/^[a-zA-Z0-9_-]{1,30}$/.test(account)) {
    return res.status(400).send(
      'Parámetro "account" inválido. Usá solo letras, números, guión o guión bajo (máx 30 chars).<br>' +
      'Ejemplo: <a href="/auth/google?account=trabajo">/auth/google?account=trabajo</a>',
    );
  }

  const auth = createOAuth2Client();
  const url = auth.generateAuthUrl({
    access_type: 'offline',   // necesario para obtener refresh_token
    prompt: 'consent',        // forzar consent para siempre obtener refresh_token
    scope: SCOPES,
    state: account,           // pasamos el nombre de cuenta como state
  });

  res.redirect(url);
});

/**
 * GET /auth/google/callback
 * Google redirige acá con el código de autorización.
 */
router.get(['/auth/google/callback', '/auth/google/callback/'], async (req, res) => {
  const { code, state: account, error } = req.query;

  if (error) {
    console.error('[auth] Google OAuth error:', error);
    return res.status(400).send('Error en la autenticación con Google. Intentá de nuevo.');
  }

  if (!code || !account || !/^[a-zA-Z0-9_-]{1,30}$/.test(account)) {
    return res.status(400).send('Parámetros inválidos en el callback.');
  }

  try {
    const auth = createOAuth2Client();
    const { tokens } = await auth.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(400).send(
        'Google no devolvió refresh_token. ' +
        'Revocá el acceso en <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> ' +
        'y volvé a autorizar.',
      );
    }

    await saveTokens(account, tokens);

    res.redirect('/dashboard');
  } catch (err) {
    // No exponer detalles del error OAuth al usuario
    console.error('[auth] Error intercambiando código OAuth:', err.code || 'UNKNOWN');
    res.status(500).send('Error interno al procesar la autenticación. Intentá de nuevo.');
  }
});

/**
 * GET /auth/status
 * Muestra qué cuentas están conectadas (útil durante el setup).
 */
router.get('/auth/status', async (req, res) => {
  const accounts = await listConnectedAccounts();
  if (accounts.length === 0) {
    return res.send(`
      <h2>Sin cuentas conectadas</h2>
      <p>Conectá tu primera cuenta:</p>
      <ul>
        <li><a href="/auth/google?account=trabajo">Cuenta de trabajo</a></li>
        <li><a href="/auth/google?account=personal">Cuenta personal</a></li>
      </ul>
    `);
  }

  const links = accounts
    .map((a) => `<li>✅ <strong>${a}</strong> — <a href="/auth/google?account=${a}">Reconectar</a></li>`)
    .join('');

  res.send(`
    <h2>Cuentas conectadas</h2>
    <ul>${links}</ul>
    <p>Agregar otra: <a href="/auth/google?account=nueva_cuenta">/auth/google?account=nueva_cuenta</a></p>
  `);
});

export default router;
