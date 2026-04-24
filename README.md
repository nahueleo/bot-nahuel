# WhatsApp Calendar Bot 🤖📅

Bot de WhatsApp inteligente que gestiona tu calendario de Google Calendar usando IA.

## Funcionalidades

### ✅ Crear eventos
- Agenda reuniones y citas nuevas
- Busca horarios disponibles automáticamente
- Envía invitaciones a participantes

### ✅ Ver agenda
- Consulta tus eventos por fecha
- Lista reuniones programadas
- Muestra detalles completos

### ✅ Editar eventos
- Modifica fecha, hora y título
- Actualiza invitados y ubicación
- Cambia descripción del evento

### ✅ Eliminar eventos
- Cancela reuniones existentes
- Envía notificaciones de cancelación

## Cómo usar

### 1. Conectar cuentas
```
http://localhost:3000/auth/google?account=trabajo
http://localhost:3000/auth/google?account=personal
```

### 2. Chatear con el bot
Envía mensajes naturales como:
- "Agendame una reunión mañana a las 3pm"
- "¿Qué tengo programado hoy?"
- "Cambia la reunión de mañana a las 4pm"
- "Cancela la reunión con Juan"

### 3. Comandos especiales
- `reset` - Limpia el historial de conversación

## Tecnologías

- **Node.js** + **Express**
- **OpenRouter** (Claude-3-Haiku)
- **Google Calendar API**
- **WhatsApp Cloud API**
- **Redis** para persistencia
- **Railway** para deployment

## Deploy

Ver [DEPLOY.md](DEPLOY.md) para instrucciones completas.

## Desarrollo

```bash
npm install
npm run dev  # desarrollo con watch
npm start    # producción
```

## Variables de entorno

Ver `.env.example` para todas las variables requeridas.