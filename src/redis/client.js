import { createClient } from 'redis';
import { config } from '../config/index.js';

let client = null;

export async function getRedisClient() {
  if (client && client.isReady) return client;

  client = createClient({ url: config.redis.url });

  client.on('error', (err) => {
    // Log solo el tipo de error, nunca el connection string completo (contiene credenciales)
    console.error('[redis] Error de conexión:', err.code || 'UNKNOWN');
  });

  await client.connect();
  console.log('[redis] Conectado.');
  return client;
}

export async function closeRedis() {
  if (client) await client.quit();
}
