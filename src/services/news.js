// Google News RSS — free, no API key needed
const FEEDS = {
  argentina: 'https://news.google.com/rss/search?q=argentina&hl=es-419&gl=AR&ceid=AR:es-419',
  cordoba:   'https://news.google.com/rss/search?q=c%C3%B3rdoba+argentina&hl=es-419&gl=AR&ceid=AR:es-419',
  belgrano:  'https://news.google.com/rss/search?q=belgrano+c%C3%B3rdoba+f%C3%BAtbol&hl=es-419&gl=AR&ceid=AR:es-419',
};

function unescapeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseRSSItems(xml, max = 5) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null && items.length < max) {
    const block = m[1];
    // Titles can be plain text or wrapped in CDATA
    const titleM = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    if (!titleM) continue;
    let title = unescapeHtml(titleM[1].trim());
    // Google News appends " - Source Name" — strip it for cleaner output
    title = title.replace(/ - [^-]{1,50}$/, '').trim();
    if (title.length > 10) items.push(title);
  }
  return items;
}

async function fetchFeed(url, max = 5) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BotNahuel/1.0)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRSSItems(xml, max);
  } catch (err) {
    console.warn(`[news] Error fetching feed ${url}:`, err.message);
    return [];
  }
}

/**
 * Fetches headlines for Argentina, Córdoba and Belgrano in parallel.
 */
export async function getNews() {
  const [argentina, cordoba, belgrano] = await Promise.all([
    fetchFeed(FEEDS.argentina, 4),
    fetchFeed(FEEDS.cordoba, 4),
    fetchFeed(FEEDS.belgrano, 4),
  ]);
  return { argentina, cordoba, belgrano };
}

export function formatNewsMessage({ argentina, cordoba, belgrano }) {
  const parts = [];
  if (belgrano.length)  parts.push(`⚽ *Belgrano de Córdoba*\n${belgrano.map(t => `• ${t}`).join('\n')}`);
  if (cordoba.length)   parts.push(`🏙️ *Noticias de Córdoba*\n${cordoba.map(t => `• ${t}`).join('\n')}`);
  if (argentina.length) parts.push(`🇦🇷 *Noticias de Argentina*\n${argentina.map(t => `• ${t}`).join('\n')}`);
  return parts.join('\n\n');
}
