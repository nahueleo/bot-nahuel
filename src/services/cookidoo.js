const COOKIDOO_KETO_COLLECTION = 'https://cookidoo.es/collection/es/p/col360903';

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeTitle(title) {
  return decodeHtml(title)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function looksUseful(title, query) {
  if (!title || title.length < 4) return false;
  if (/cocina keto|cookidoo|copyright|terminos|privacidad|iniciar sesion|registrate/i.test(title)) return false;
  const q = String(query || '').toLowerCase();
  if (!q) return true;
  const meaningful = q
    .split(/\s+/)
    .filter(part => part.length > 3 && !['keto', 'low', 'carb', 'receta'].includes(part));
  if (!meaningful.length) return true;
  return meaningful.some(part => title.toLowerCase().includes(part));
}

export async function searchCookidooRecipes(query = 'keto low carb', maxResults = 8) {
  const url = COOKIDOO_KETO_COLLECTION;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 BotNahuel/1.0 recipe-link-preview',
      accept: 'text/html',
    },
  });
  if (!res.ok) throw new Error(`Cookidoo respondió HTTP ${res.status}`);

  const html = await res.text();
  const titles = new Set();

  for (const match of html.matchAll(/>\s*([^<>]{4,120})\s*</g)) {
    const title = normalizeTitle(match[1]);
    if (looksUseful(title, query)) titles.add(title);
    if (titles.size >= maxResults) break;
  }

  return [...titles].slice(0, maxResults).map((title) => ({
    title,
    url,
    source: 'Cookidoo Cocina Keto',
  }));
}
