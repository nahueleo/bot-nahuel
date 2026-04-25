import express from 'express';
import { config } from './config/index.js';
import { getRedisClient } from './redis/client.js';
import { startReminderProcessor } from './redis/reminder-processor.js';
import { startScheduler } from './tasks/scheduler.js';
import { keyManager } from './ai/key-manager.js';
import authRouter from './auth/google.js';
import webhookRouter from './whatsapp/webhook.js';
import dashboardRouter from './dashboard/routes.js';

const app = express();

// ─── JSON parsing + captura del body crudo ───────────────────────────────────
// La opción `verify` de express.json() nos da el buffer crudo antes del parse,
// necesario para verificar la firma HMAC de WhatsApp sin consumir el stream dos veces.
app.use(express.json({
  limit: '20mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use('/', webhookRouter);    // GET /webhook + POST /webhook
app.use('/', authRouter);       // GET /auth/google + /auth/google/callback + /auth/status
app.use('/', dashboardRouter);  // GET /dashboard + /api/status + /api/events

// ─── Favicon ─────────────────────────────────────────────────────────────────────
app.get('/favicon.ico', (req, res) => {
  const faviconData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAdUlEQVR4nO3WwREAEQyFYR3sUQ+q2ua2SRcaIJ4kBjvvkCP/dzESnpjKzgkEEKA59H65OUsBvagVAwFm4zOIIUAbRxEiwBpHEF2AV3yEIKAJ8I5LCAIIOBOw/RkS4I2QGmd/x1YEcvcdKxmK0dx151pOwK8AFaEywuqzWpebAAAAAElFTkSuQmCC',
    'base64'
  );
  res.type('image/png').send(faviconData);
});

// ─── Root redirect ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dashboard'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Error handler global ─────────────────────────────────────────────────────
// Nunca exponer stack traces ni detalles internos al cliente.
app.use((err, req, res, next) => {
  console.error('[app] Error no manejado:', err.code || 'UNKNOWN', err.message?.slice(0, 100));
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    // Conectar Redis antes de aceptar requests
    await getRedisClient();

    // Cargar estado de keys de AI (deshabilitadas) desde Redis
    await keyManager.init();

    // Iniciar procesador de recordatorios
    startReminderProcessor();

    // Iniciar scheduler de tareas programadas
    await startScheduler();

    app.listen(config.port, () => {
      console.log(`\n🤖 WhatsApp Calendar Bot corriendo en http://localhost:${config.port}`);
      console.log('');
      console.log('📋 Próximos pasos:');
      console.log(`   1. Conectá tu cuenta de trabajo:   http://localhost:${config.port}/auth/google?account=trabajo`);
      console.log(`   2. Conectá tu cuenta personal:     http://localhost:${config.port}/auth/google?account=personal`);
      console.log(`   3. Ver cuentas conectadas:         http://localhost:${config.port}/auth/status`);
      console.log(`   4. Configurá el webhook en Meta:   POST https://<tu-tunnel>/webhook`);
      console.log('');
    });
  } catch (err) {
    console.error('[app] Error en startup:', err.message);
    process.exit(1);
  }
}

start();
