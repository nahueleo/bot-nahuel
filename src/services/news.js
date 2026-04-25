// Google News RSS — free, no API key needed

export const TOPICS = {
  argentina:      { label: 'Argentina',        emoji: '🇦🇷', query: 'argentina noticias' },
  cordoba:        { label: 'Córdoba',           emoji: '🏙️', query: 'córdoba argentina' },
  belgrano:       { label: 'Belgrano',          emoji: '⚽', query: 'belgrano córdoba fútbol' },
  river:          { label: 'River Plate',       emoji: '🏆', query: 'river plate fútbol' },
  boca:           { label: 'Boca Juniors',      emoji: '💙', query: 'boca juniors fútbol' },
  seleccion:      { label: 'Selección',         emoji: '🇦🇷', query: 'selección argentina fútbol nacional' },
  tecnologia:     { label: 'Tecnología',        emoji: '💻', query: 'tecnología inteligencia artificial IA' },
  economia:       { label: 'Economía',          emoji: '📊', query: 'economía argentina inflación reservas' },
  politica:       { label: 'Política',          emoji: '🏛️', query: 'política argentina gobierno milei' },
  mundo:          { label: 'Mundo',             emoji: '🌍', query: 'noticias internacionales mundo' },
  deportes:       { label: 'Deportes',          emoji: '🏅', query: 'deportes argentina' },
  salud:          { label: 'Salud',             emoji: '🏥', query: 'salud medicina argentina' },
  ciencia:        { label: 'Ciencia',           emoji: '🔬', query: 'ciencia descubrimientos investigación' },
  entretenimiento:{ label: 'Entretenimiento',   emoji: '🎬', query: 'entretenimiento cine música argentina' },
  gaming:         { label: 'Gaming',            emoji: '🎮', query: 'videojuegos gaming PlayStation Xbox Nintendo' },
  finanzas:       { label: 'Finanzas',          emoji: '💰', query: 'dólar finanzas mercado argentina inversión' },
  cultura:        { label: 'Cultura',           emoji: '🎭', query: 'cultura arte teatro argentina' },
  autos:          { label: 'Autos',             emoji: '🚗', query: 'autos automóviles nuevos lanzamientos' },
  formula1:       { label: 'Fórmula 1',         emoji: '🏎️', query: 'fórmula 1 F1 Gran Premio' },
  champions:      { label: 'Champions League',  emoji: '⭐', query: 'champions league UEFA' },
  nba:            { label: 'NBA',               emoji: '🏀', query: 'NBA basketball' },
  startup:        { label: 'Startups',          emoji: '🚀', query: 'startups emprendimiento tecnología argentina' },
  cripto:         { label: 'Cripto News',       emoji: '₿',  query: 'criptomonedas bitcoin ethereum' },
  clima:          { label: 'Clima',             emoji: '🌦️', query: 'clima tiempo meteorología argentina' },
};

function buildFeedURL(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=es-419&gl=AR&ceid=AR:es-419`;
}

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
    const titleM = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    if (!titleM) continue;
    let title = unescapeHtml(titleM[1].trim());
    title = title.replace(/ - [^-]{1,60}$/, '').trim();
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
    console.warn(`[news] Error fetching feed:`, err.message);
    return [];
  }
}

/**
 * Fetches headlines for the given topic IDs in parallel.
 * @param {string[]} topicIds - Array of topic keys from TOPICS
 * @param {number} maxPerTopic - Max headlines per topic
 * @returns {Record<string, string[]>}
 */
export async function fetchTopics(topicIds, maxPerTopic = 4) {
  const validIds = topicIds.filter(id => TOPICS[id]);
  const results = await Promise.all(
    validIds.map(id => fetchFeed(buildFeedURL(TOPICS[id].query), maxPerTopic))
  );
  const out = {};
  validIds.forEach((id, i) => { out[id] = results[i]; });
  return out;
}

/**
 * @param {Record<string, string[]>} topicsData - { topicId: headlines[] }
 * @param {string[]} topicIds - ordered list to render
 */
export function formatTopicsMessage(topicsData, topicIds) {
  const parts = topicIds
    .filter(id => topicsData[id]?.length && TOPICS[id])
    .map(id => {
      const { label, emoji } = TOPICS[id];
      const headlines = topicsData[id].map(t => `• ${t}`).join('\n');
      return `${emoji} *${label}*\n${headlines}`;
    });
  return parts.join('\n\n');
}

// ── Backward-compatible helpers ───────────────────────────────────────────────

/**
 * Legacy: fetches argentina + cordoba + belgrano in one call.
 */
export async function getNews() {
  const data = await fetchTopics(['argentina', 'cordoba', 'belgrano'], 4);
  return { argentina: data.argentina, cordoba: data.cordoba, belgrano: data.belgrano };
}

export function formatNewsMessage({ argentina = [], cordoba = [], belgrano = [] }) {
  const parts = [];
  if (belgrano.length)  parts.push(`⚽ *Belgrano de Córdoba*\n${belgrano.map(t => `• ${t}`).join('\n')}`);
  if (cordoba.length)   parts.push(`🏙️ *Noticias de Córdoba*\n${cordoba.map(t => `• ${t}`).join('\n')}`);
  if (argentina.length) parts.push(`🇦🇷 *Noticias de Argentina*\n${argentina.map(t => `• ${t}`).join('\n')}`);
  return parts.join('\n\n');
}
