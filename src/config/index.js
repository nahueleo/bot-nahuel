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

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  whatsapp: {
    accessToken:   required('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken:   required('WHATSAPP_VERIFY_TOKEN'),
    appSecret:     required('WHATSAPP_APP_SECRET'),
  },

  google: {
    clientId:     required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    redirectUri:  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback',
  },

  groq: {
    apiKey: required('GROQ_API_KEY'),
  },

  openrouter: {
    apiKey: required('OPENROUTER_API_KEY', true),
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
};
