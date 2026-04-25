// Open-Meteo — completely free, no API key required

const WMO_DESCRIPTIONS = {
  0: 'Cielo despejado', 1: 'Principalmente despejado', 2: 'Parcialmente nublado', 3: 'Nublado',
  45: 'Niebla', 48: 'Niebla con escarcha',
  51: 'Llovizna ligera', 53: 'Llovizna moderada', 55: 'Llovizna intensa',
  56: 'Llovizna helada ligera', 57: 'Llovizna helada intensa',
  61: 'Lluvia ligera', 63: 'Lluvia moderada', 65: 'Lluvia intensa',
  71: 'Nevada ligera', 73: 'Nevada moderada', 75: 'Nevada intensa',
  77: 'Granizo',
  80: 'Chubascos ligeros', 81: 'Chubascos moderados', 82: 'Chubascos fuertes',
  85: 'Nieve con chubascos ligera', 86: 'Nieve con chubascos fuerte',
  95: 'Tormenta eléctrica', 96: 'Tormenta con granizo', 99: 'Tormenta con granizo fuerte',
};

const WMO_EMOJIS = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌧️', 56: '🌧️', 57: '🌧️',
  61: '🌧️', 63: '🌧️', 65: '⛈️',
  71: '❄️', 73: '❄️', 75: '❄️', 77: '🌨️',
  80: '🌦️', 81: '🌧️', 82: '⛈️',
  85: '🌨️', 86: '🌨️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
};

// In-memory geocoding cache to avoid repeated lookups
const geocodeCache = new Map();

/**
 * Resolves a city name to {lat, lon, displayName} using Open-Meteo geocoding.
 * Falls back to Córdoba, Argentina if the name can't be resolved.
 */
async function geocodeCity(city) {
  const key = city.toLowerCase().trim();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
    const data = await res.json();
    if (data.results?.length) {
      const r = data.results[0];
      const result = {
        lat: r.latitude,
        lon: r.longitude,
        displayName: r.name + (r.admin1 ? `, ${r.admin1}` : '') + (r.country ? `, ${r.country}` : ''),
      };
      geocodeCache.set(key, result);
      return result;
    }
  } catch (err) {
    console.warn('[weather] Geocoding error for', city, ':', err.message);
  }

  // Default to Córdoba, Argentina
  const fallback = { lat: -31.4135, lon: -64.1811, displayName: 'Córdoba, Argentina' };
  geocodeCache.set(key, fallback);
  return fallback;
}

async function fetchWeatherData(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weathercode,windspeed_10m,relativehumidity_2m,apparent_temperature` +
    `&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max,sunrise,sunset` +
    `&timezone=America%2FArgentina%2FBuenos_Aires&forecast_days=1`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Open-Meteo API error: ${res.status}`);
  return res.json();
}

/**
 * Fetches weather for any city name.
 * @param {string} city - e.g. 'Buenos Aires', 'Madrid, España'
 */
export async function getWeatherForCity(city = 'Córdoba, Argentina') {
  const { lat, lon, displayName } = await geocodeCity(city);
  const data = await fetchWeatherData(lat, lon);

  const cur = data.current;
  const day = data.daily;
  const code = cur.weathercode;

  return {
    city: displayName,
    temperature: Math.round(cur.temperature_2m),
    feelsLike: Math.round(cur.apparent_temperature),
    maxTemp: Math.round(day.temperature_2m_max[0]),
    minTemp: Math.round(day.temperature_2m_min[0]),
    description: WMO_DESCRIPTIONS[code] ?? 'Sin datos',
    emoji: WMO_EMOJIS[code] ?? '🌡️',
    humidity: cur.relativehumidity_2m,
    windSpeed: Math.round(cur.windspeed_10m),
    rainProbability: day.precipitation_probability_max[0] ?? 0,
    sunrise: day.sunrise[0]?.slice(11, 16) ?? '--',
    sunset: day.sunset[0]?.slice(11, 16) ?? '--',
    code,
  };
}

/** Backward-compatible: Córdoba, Argentina */
export async function getCordobaWeather() {
  return getWeatherForCity('Córdoba, Argentina');
}

export function formatWeatherMessage(w) {
  const rain = w.rainProbability > 0 ? `\n☔ Prob. de lluvia: ${w.rainProbability}%` : '';
  return (
    `${w.emoji} *Clima en ${w.city}*\n` +
    `🌡️ ${w.temperature}°C (sensación ${w.feelsLike}°C)\n` +
    `📈 Máx ${w.maxTemp}°C / 📉 Mín ${w.minTemp}°C\n` +
    `${w.description}\n` +
    `💧 Humedad: ${w.humidity}% | 🌬️ Viento: ${w.windSpeed} km/h` +
    rain +
    `\n🌅 Amanecer: ${w.sunrise} | 🌇 Atardecer: ${w.sunset}`
  );
}
