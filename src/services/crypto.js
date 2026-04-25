// CoinGecko public API — free, no key needed
const COINS_MAP = {
  BTC:   'bitcoin',
  ETH:   'ethereum',
  SOL:   'solana',
  ADA:   'cardano',
  DOGE:  'dogecoin',
  MATIC: 'matic-network',
  DOT:   'polkadot',
  LINK:  'chainlink',
  AVAX:  'avalanche-2',
  LTC:   'litecoin',
  UNI:   'uniswap',
  XRP:   'ripple',
  BNB:   'binancecoin',
  SHIB:  'shiba-inu',
  TRX:   'tron',
};

export const AVAILABLE_COINS = Object.keys(COINS_MAP);

/**
 * Fetches current USD prices + 24h change for the requested coins.
 * @param {string[]} coins - Array of coin symbols, e.g. ['BTC', 'ETH']
 * @returns {Record<string, { usd: number, change24h: number }>}
 */
export async function getCryptoPrices(coins = ['BTC', 'ETH']) {
  const upperCoins = coins.map(c => c.toUpperCase()).filter(c => COINS_MAP[c]);
  if (!upperCoins.length) return {};

  const ids = upperCoins.map(c => COINS_MAP[c]).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: { 'User-Agent': 'BotNahuel/1.0' },
  });
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
  const data = await res.json();

  const result = {};
  for (const coin of upperCoins) {
    const id = COINS_MAP[coin];
    if (id && data[id]) {
      result[coin] = {
        usd: data[id].usd,
        change24h: data[id].usd_24h_change ?? 0,
      };
    }
  }
  return result;
}

export function formatCryptoMessage(prices, coins) {
  const lines = coins
    .map(coin => {
      const p = prices[coin.toUpperCase()];
      if (!p) return null;
      const arrow = p.change24h >= 0 ? '📈' : '📉';
      const sign  = p.change24h >= 0 ? '+' : '';
      const usd =
        p.usd >= 1000
          ? p.usd.toLocaleString('en-US', { maximumFractionDigits: 0 })
          : p.usd.toLocaleString('en-US', { maximumFractionDigits: 4 });
      return `• ${coin}: $${usd} USD  ${arrow} ${sign}${p.change24h.toFixed(2)}%`;
    })
    .filter(Boolean);

  if (!lines.length) return '';
  return `₿ *Criptomonedas*\n${lines.join('\n')}`;
}
