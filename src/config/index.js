import dotenv from 'dotenv';
dotenv.config();

/**
 * Obtiene una variable de entorno requerida.
 * En producción o cuando el valor es crítico, falla si falta.
 */
function required(name, fatal = false) {
  const val = process.env[name];
  if (!val) {
    const isDev = process.env.NODE_ENV !== 'production';
    const msg = `[config] Variable de entorno requerida no encontrada: ${name}`;

    if (isDev && !fatal) {
      console.warn(`${msg} (usando valor vacío en desarrollo)`);
      return '';
    }

    console.error(msg);
    process.exit(1);
  }
  return val;
}

const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

// Derive public base URL from GOOGLE_REDIRECT_URI, or use explicit PUBLIC_URL if set.
// e.g. "https://abc.ngrok.io/auth/google/callback" → "https://abc.ngrok.io"
const defaultPublicUrl = process.env.PUBLIC_URL
  || redirectUri.replace(/\/auth\/google\/callback\/?$/, '');

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Public-facing base URL (used to generate auth links sent via WhatsApp)
  publicUrl: defaultPublicUrl,

  // Owner's WhatsApp number in international format (e.g. 5491133334444)
  ownerPhone: process.env.OWNER_PHONE || '',

  whatsapp: {
    accessToken:   required('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken:   required('WHATSAPP_VERIFY_TOKEN'),
    appSecret:     required('WHATSAPP_APP_SECRET'),
  },

  google: {
    clientId:     required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    redirectUri,
  },

  groq: {
    apiKey: required('GROQ_API_KEY'),
  },

  openrouter: {
    apiKeys: required('OPENROUTER_API_KEY', true)
      .split(',')
      .map(k => k.trim())
      .filter(Boolean),
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
};
