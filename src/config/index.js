import dotenv from 'dotenv';
dotenv.config();

/**
 * Obtiene una variable de entorno requerida.
 * Falla en startup si falta — mejor fallar temprano que en runtime.
 */
function required(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[config] Variable de entorno requerida no encontrada: ${name}`);
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

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
};
