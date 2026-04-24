# WhatsApp Calendar Bot 🤖📅

Bot de WhatsApp inteligente que gestiona tu calendario de Google Calendar usando IA.

## Funcionalidades

### ✅ Gestión Completa de Eventos
- **Crear eventos** únicos o recurrentes
- **Ver eventos** por fecha o búsqueda inteligente
- **Editar eventos** existentes (fecha, hora, título, invitados)
- **Eliminar eventos** del calendario

### 🔄 Eventos Recurrentes
- Reuniones semanales/mensuales/diarias
- Standups diarios, revisiones mensuales
- Control de frecuencia e intervalo

### 🔍 Búsqueda Inteligente
- Buscar por palabras clave en título/descripción
- "Muéstrame reuniones con Juan"
- "Eventos sobre presupuesto"

### ⏰ Recordatorios Automáticos
- Recordatorios programables por WhatsApp
- "Recuérdame 15min antes de la reunión"
- Procesamiento automático cada minuto

### 📋 Plantillas Predefinidas
- **standup**: Daily standup (30min)
- **reunion_equipo**: Reunión semanal (60min)
- **revision_mensual**: Revisión mensual (90min)
- **entrevista**: Entrevista (60min)
- **presentacion**: Presentación (45min)
- **capacitacion**: Capacitación (120min)

## Cómo usar

### 1. Conectar cuentas
```
http://localhost:3000/auth/google?account=trabajo
http://localhost:3000/auth/google?account=personal
```

### 2. Chatear con el bot
Envía mensajes naturales como:
- "Agendame una reunión mañana a las 3pm"
- "Crea un standup todos los lunes a las 10am"
- "¿Qué tengo programado hoy?"
- "Muéstrame reuniones con presupuesto"
- "Cambia la reunión de mañana a las 4pm"
- "Cancela la reunión del viernes"
- "Recuérdame 15min antes de la reunión con Juan"

### 3. Comandos especiales
- `reset` - Limpia el historial de conversación

## Tecnologías

- **Node.js** + **Express**
- **OpenRouter** (Claude-3-Haiku)
- **Google Calendar API**
- **WhatsApp Cloud API**
- **Redis** para persistencia y recordatorios automáticos
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