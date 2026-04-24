import OpenAI from 'openai';
import { config } from '../config/index.js';
import { getRedisClient } from '../redis/client.js';

const REDIS_KEY = 'ai:disabled_keys';

const PROVIDERS = {
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    model:   'anthropic/claude-3-haiku',
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    model:   'llama-3.3-70b-versatile',
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model:   'gemini-1.5-flash',
  },
};

function buildKeys() {
  const keys = [];
  for (const [provider, cfg] of Object.entries(PROVIDERS)) {
    const apiKeys = config[provider]?.apiKeys ?? [];
    for (let i = 0; i < apiKeys.length; i++) {
      keys.push({
        id:     `${provider}_${i}`,
        provider,
        model:  cfg.model,
        client: new OpenAI({ apiKey: apiKeys[i], baseURL: cfg.baseURL }),
      });
    }
  }
  return keys;
}

function isPermanentError(err) {
  const msg = (err.error?.message || err.message || '').toLowerCase();
  return (
    err.status === 401 ||
    err.status === 403 ||
    (err.status === 402 && /insufficient credits|no credits|out of credits|never purchased/i.test(msg))
  );
}

class KeyManager {
  constructor() {
    this.keys = buildKeys();
    this._idx = 0;
    this._disabled = new Set();
    this._initialized = false;
    console.log(`[key-manager] ${this.keys.length} key(s) configurada(s): ${this.keys.map(k => k.id).join(', ')}`);
  }

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    try {
      const redis = await getRedisClient();
      const stored = await redis.hGetAll(REDIS_KEY);
      for (const id of Object.keys(stored)) {
        if (this.keys.find(k => k.id === id)) {
          this._disabled.add(id);
          const data = JSON.parse(stored[id]);
          console.warn(`[key-manager] Key deshabilitada (Redis): ${id} — ${data.reason}`);
        }
      }
    } catch (err) {
      console.error('[key-manager] Error cargando estado desde Redis:', err.message);
    }
    const active = this._activeKeys();
    console.log(`[key-manager] Keys activas: ${active.length}/${this.keys.length}`);
    if (active.length === 0) {
      console.error('[key-manager] ⚠️  No hay keys activas. Configurá OPENROUTER_API_KEY, GROQ_API_KEY o GEMINI_API_KEY.');
    }
  }

  _activeKeys() {
    return this.keys.filter(k => !this._disabled.has(k.id));
  }

  async _disable(key, reason) {
    this._disabled.add(key.id);
    try {
      const redis = await getRedisClient();
      await redis.hSet(REDIS_KEY, key.id, JSON.stringify({
        reason:      reason.slice(0, 200),
        disabledAt:  new Date().toISOString(),
      }));
    } catch (err) {
      console.error('[key-manager] Error guardando key deshabilitada en Redis:', err.message);
    }
    const remaining = this._activeKeys().length;
    console.warn(`[key-manager] ⛔ Key DESHABILITADA: ${key.id} — "${reason.slice(0, 80)}". Activas: ${remaining}/${this.keys.length}`);
  }

  /** Reactiva una key eliminándola del set de inhabilitadas y de Redis. */
  async enableKey(id) {
    this._disabled.delete(id);
    try {
      const redis = await getRedisClient();
      await redis.hDel(REDIS_KEY, id);
      console.log(`[key-manager] ✅ Key reactivada: ${id}`);
    } catch (err) {
      console.error('[key-manager] Error reactivando key en Redis:', err.message);
    }
  }

  /** Devuelve el estado de todas las keys (para diagnóstico). */
  status() {
    return this.keys.map(k => ({
      id:       k.id,
      provider: k.provider,
      model:    k.model,
      active:   !this._disabled.has(k.id),
    }));
  }

  /**
   * Wrapper de chat.completions.create con rotación multi-proveedor.
   * - Round-robin sobre todas las keys activas en éxito.
   * - En error permanente (401/403/402-créditos): deshabilita la key y prueba la siguiente.
   * - En 429: rota sin deshabilitar.
   * - Otros errores (5xx, red): propaga sin rotar.
   */
  async createCompletion(params) {
    if (!this._initialized) await this.init();

    const active = this._activeKeys();
    if (active.length === 0) throw new Error('No hay keys de AI activas disponibles');

    for (let i = 0; i < active.length; i++) {
      const key = active[(this._idx + i) % active.length];

      try {
        const result = await key.client.chat.completions.create({ ...params, model: key.model });
        // Avanzar índice para distribuir carga (round-robin)
        const nowActive = this._activeKeys();
        if (nowActive.length > 0) this._idx = (this._idx + 1) % nowActive.length;
        console.log(`[key-manager] ✓ ${key.id} (${key.model})  tokens=${result.usage?.total_tokens ?? '?'}`);
        return result;
      } catch (err) {
        if (isPermanentError(err)) {
          await this._disable(key, err.error?.message || err.message || `HTTP ${err.status}`);
          // continuar con la siguiente key
        } else if (err.status === 429) {
          console.warn(`[key-manager] 429 en ${key.id}. Rotando sin deshabilitar...`);
          // continuar con la siguiente key
        } else {
          throw err; // error de red, 5xx, etc. — no rotar
        }
      }
    }

    throw new Error('Todas las keys activas fallaron en esta solicitud');
  }
}

export const keyManager = new KeyManager();
