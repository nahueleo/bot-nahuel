// ZenQuotes.io — free public API, no key needed
const ZENQUOTES_URL = 'https://zenquotes.io/api/today';

// Fallback quotes in Spanish for when the API is unavailable
const FALLBACK_QUOTES = [
  { q: 'La única forma de hacer un gran trabajo es amar lo que haces.', a: 'Steve Jobs' },
  { q: 'El éxito es la suma de pequeños esfuerzos repetidos día tras día.', a: 'Robert Collier' },
  { q: 'No cuentes los días, haz que los días cuenten.', a: 'Muhammad Ali' },
  { q: 'El futuro pertenece a quienes creen en la belleza de sus sueños.', a: 'Eleanor Roosevelt' },
  { q: 'En medio de la dificultad reside la oportunidad.', a: 'Albert Einstein' },
  { q: 'La vida es lo que pasa mientras estás ocupado haciendo otros planes.', a: 'John Lennon' },
  { q: 'El único límite para nuestros logros de mañana son nuestras dudas de hoy.', a: 'Franklin D. Roosevelt' },
  { q: 'No es la especie más fuerte la que sobrevive, sino la más adaptable al cambio.', a: 'Charles Darwin' },
  { q: 'Cae siete veces, levántate ocho.', a: 'Proverbio japonés' },
  { q: 'Empieza donde estás. Usa lo que tienes. Haz lo que puedes.', a: 'Arthur Ashe' },
  { q: 'El único modo de hacer bien tu trabajo es amando lo que haces.', a: 'Steve Jobs' },
  { q: 'La perseverancia es la madre del éxito.', a: 'Honoré de Balzac' },
  { q: 'Soñá en grande y atrévete a fallar.', a: 'Norman Vaughan' },
  { q: 'El talento gana partidos, pero el trabajo en equipo gana campeonatos.', a: 'Michael Jordan' },
  { q: 'Si podés soñarlo, podés hacerlo.', a: 'Walt Disney' },
  { q: 'Lo que no te mata te hace más fuerte.', a: 'Friedrich Nietzsche' },
  { q: 'La creatividad es la inteligencia divirtiéndose.', a: 'Albert Einstein' },
  { q: 'El éxito usualmente llega a quienes están demasiado ocupados para buscarlo.', a: 'Henry David Thoreau' },
  { q: 'No hay sustituto para el trabajo duro.', a: 'Thomas Edison' },
  { q: 'Primero resolvé el problema, luego escribí el código.', a: 'John Johnson' },
  { q: 'Los datos son el petróleo del siglo XXI.', a: 'Clive Humby' },
  { q: 'La mejor manera de predecir el futuro es inventarlo.', a: 'Alan Kay' },
  { q: 'Haz hoy lo que otros no harán, para mañana tener lo que otros no tendrán.', a: 'Jerry Rice' },
  { q: 'El mayor riesgo es no correr ningún riesgo.', a: 'Mark Zuckerberg' },
  { q: 'Cada experto fue alguna vez un principiante.', a: 'Helen Hayes' },
  { q: 'La disciplina es el puente entre metas y logros.', a: 'Jim Rohn' },
  { q: 'Rodeate de personas que tengan sueños, determinación y hambre.', a: 'Les Brown' },
  { q: 'No esperes el momento perfecto. Toma el momento y hazlo perfecto.', a: 'Zoey Sayward' },
  { q: 'El conocimiento es poder.', a: 'Francis Bacon' },
  { q: 'Nunca es demasiado tarde para ser lo que podrías haber sido.', a: 'George Eliot' },
];

/**
 * Returns a daily motivational quote.
 * Tries ZenQuotes API first, falls back to local list on error.
 * @returns {{ quote: string, author: string }}
 */
export async function getDailyQuote() {
  try {
    const res = await fetch(ZENQUOTES_URL, {
      signal: AbortSignal.timeout(8_000),
      headers: { 'User-Agent': 'BotNahuel/1.0' },
    });
    if (!res.ok) throw new Error(`ZenQuotes error: ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data[0]?.q) {
      return { quote: data[0].q, author: data[0].a };
    }
  } catch {
    // fall through to local fallback
  }

  // Deterministic daily selection from fallback list
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000
  );
  const pick = FALLBACK_QUOTES[dayOfYear % FALLBACK_QUOTES.length];
  return { quote: pick.q, author: pick.a };
}

export function formatQuoteMessage({ quote, author }) {
  return `💬 *Frase del día*\n_"${quote}"_\n— ${author}`;
}
