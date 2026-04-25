// dolarapi.com — tasas del dólar en Argentina, gratis, sin API key
const DOLAR_API = 'https://dolarapi.com/v1/dolares';

export const RATE_TYPES = ['oficial', 'blue', 'mep', 'cripto', 'mayorista', 'tarjeta'];

const RATE_LABELS = {
  oficial:    { label: 'Dólar Oficial',    emoji: '🏦' },
  blue:       { label: 'Dólar Blue',       emoji: '💵' },
  mep:        { label: 'Dólar MEP',        emoji: '📊' },
  cripto:     { label: 'Dólar Cripto',     emoji: '₿'  },
  mayorista:  { label: 'Dólar Mayorista',  emoji: '🏪' },
  tarjeta:    { label: 'Dólar Tarjeta',    emoji: '💳' },
};

/**
 * Fetches ARS exchange rates from dolarapi.com.
 * @returns {Record<string, { compra: number, venta: number, nombre: string }>}
 */
export async function getARSRates() {
  const res = await fetch(DOLAR_API, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'BotNahuel/1.0' },
  });
  if (!res.ok) throw new Error(`DolarAPI error: ${res.status}`);
  const data = await res.json();

  const rates = {};
  for (const item of data) {
    // API returns casa: "oficial" | "blue" | "bolsa" (=mep) | "cripto" | "mayorista" | "tarjeta"
    const key = item.casa === 'bolsa' ? 'mep' : item.casa;
    rates[key] = { compra: item.compra, venta: item.venta, nombre: item.nombre };
  }
  return rates;
}

/**
 * @param {Record<string, { compra: number, venta: number }>} rates
 * @param {string[]} types - which rate keys to show
 */
export function formatCurrencyMessage(rates, types = ['oficial', 'blue']) {
  const lines = types
    .map(type => {
      const rate = rates[type];
      if (!rate) return null;
      const { label, emoji } = RATE_LABELS[type] ?? { label: type, emoji: '💱' };
      const compra = rate.compra != null ? `$${Number(rate.compra).toLocaleString('es-AR')}` : '—';
      const venta  = rate.venta  != null ? `$${Number(rate.venta).toLocaleString('es-AR')}`  : '—';
      return `${emoji} ${label}: ${compra} / ${venta}`;
    })
    .filter(Boolean);

  if (!lines.length) return '';
  return `💱 *Cotizaciones del Dólar*\n${lines.join('\n')}\n_Compra / Venta_`;
}
