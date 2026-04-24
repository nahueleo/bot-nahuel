import dotenv from 'dotenv';
dotenv.config();

// DEBUG: Log de variables disponibles
console.log('[config] NODE_ENV:', process.env.NODE_ENV);
console.log('[config] Variables de entorno disponibles:');
const envKeys = Object.keys(process.env)
  .filter(k => !k.includes('PATH') && !k.includes('npm') && k.length < 50)
  .sort();
console.log(envKeys);

console.log('[config] DEBUG - Verificando variables WhatsApp:');
console.log('  WHATSAPP_ACCESS_TOKEN exists:', !!process.env.WHATSAPP_ACCESS_TOKEN);
console.log('  WHATSAPP_PHONE_NUMBER_ID:', process.env.WHATSAPP_PHONE_NUMBER_ID);
console.log('  WHATSAPP_VERIFY_TOKEN:', process.env.WHATSAPP_VERIFY_TOKEN);
console.log('  WHATSAPP_APP_SECRET exists:', !!process.env.WHATSAPP_APP_SECRET);

/**
 * Obtiene una variable de entorno requerida.
 * En producción falla si falta. En desarrollo, usa valor vacío y advierte.
 */
function required(name) {
  const val = process.env[name];
  if (!val) {
    const isDev = process.env.NODE_ENV !== 'production';
    const msg = `[config] Variable de entorno requerida no encontrada: ${name}`;
    
    if (isDev) {
      console.warn(`${msg} (usando valor vacío en desarrollo)`);
      return '';
    } else {
      console.error(msg);
      process.exit(1);
    }
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
    apiKey: required('OPENROUTER_API_KEY'),
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
};
