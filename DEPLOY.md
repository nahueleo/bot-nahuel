# Deploy en Railway

## 1. Subir código a GitHub

```bash
cd whatsapp-calendar-bot
git init
git add .
git commit -m "initial commit"
# Crear repo en github.com y luego:
git remote add origin https://github.com/TU_USUARIO/whatsapp-calendar-bot.git
git push -u origin main
```

## 2. Crear proyecto en Railway

1. Entrá a https://railway.app y creá una cuenta (gratis)
2. **New Project → Deploy from GitHub repo** → elegí `whatsapp-calendar-bot`
3. Una vez creado el proyecto, hacé clic en **Add Service → Database → Redis**

## 3. Configurar variables de entorno

En el servicio Node.js, andá a **Variables** y agregá:

| Variable | Valor |
|----------|-------|
| `WHATSAPP_ACCESS_TOKEN` | Tu token permanente de Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | `1026001473937760` |
| `WHATSAPP_VERIFY_TOKEN` | `calendar_bot_verify_2025` |
| `WHATSAPP_APP_SECRET` | Tu app secret de Meta |
| `GOOGLE_CLIENT_ID` | Tu client ID de Google |
| `GOOGLE_CLIENT_SECRET` | Tu client secret de Google |
| `GOOGLE_REDIRECT_URI` | `https://TU-APP.railway.app/auth/google/callback` |
| `GROQ_API_KEY` | Tu API key de Groq |
| `REDIS_URL` | Lo provee Railway automáticamente como `${{Redis.REDIS_URL}}` |
| `PORT` | `3000` |

> **REDIS_URL**: En Railway, hacé clic en la variable y elegí "Reference variable" → Redis → REDIS_URL

## 4. Actualizar Google Cloud Console

1. Entrá a https://console.cloud.google.com → APIs & Services → Credentials
2. Editá tu OAuth 2.0 Client
3. En **Authorized redirect URIs** agregá:
   `https://TU-APP.railway.app/auth/google/callback`

## 5. Actualizar webhook en Meta

1. Entrá a https://developers.facebook.com/apps/2033761224246047/webhooks/
2. Actualizá la callback URL a:
   `https://TU-APP.railway.app/webhook`

## 6. Re-autenticar Google Calendar

Una vez deployado, abrí en el browser:
`https://TU-APP.railway.app/auth/google?account=personal`

(Los tokens anteriores de Redis local no se migran automáticamente)

## URL de tu app

Railway te da una URL del estilo: `https://whatsapp-calendar-bot-production.railway.app`
