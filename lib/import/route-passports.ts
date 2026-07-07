/**
 * Чистая логика импорта официальных паспортов маршрутов (visitkamchatka.ru).
 * Без сети и БД — используется скриптом scripts/import-route-passports.ts
 * и тестируется на фикстурах.
 *
 * Правило НЕ ВРАТЬ: не нашлось/не распозналось — null или ambiguous,
 * никаких догадок и автопривязок при неуверенности.
 */

export interface PassportLink {
  title: string;
  pdfUrl: string;
  /** Ведомство из контекста страницы; не распознано — null */
  agency: string | null;
  /** Сезон из контекста страницы; не распознан — null */
  season: 'summer' | 'winter' | 'all' | null;
}

export interface RouteCandidate {
  id: string;
  title: string;
}

export type MappingOutcome =
  | { kind: 'matched'; route: RouteCandidate }
  | { kind: 'ambiguous'; candidates: RouteCandidate[] }
  | { kind: 'new' };

// ── Извлечение списка PDF со страницы ────────────────────────────────────

const AGENCY_PATTERNS: Array<[RegExp, string]> = [
  [/кроноцк/i, 'ФГБУ «Кроноцкий заповедник»'],
  [/вулканы\s+камчатки/i, 'КГБУ «Вулканы Камчатки»'],
  [/министерств|минтуризм|туризм[а-я]*\s+камчатского\s+края/i, 'Минтуризма Камчатского края'],
];

const SEASON_PATTERNS: Array<[RegExp, PassportLink['season']]> = [
  [/круглогодичн/i, 'all'],
  [/зимн|зима/i, 'winter'],
  [/летн|лето/i, 'summer'],
];

function detectAgency(context: string): string | null {
  for (const [re, agency] of AGENCY_PATTERNS) {
    if (re.test(context)) return agency;
  }
  return null;
}

function detectSeason(context: string): PassportLink['season'] {
  for (const [re, season] of SEASON_PATTERNS) {
    if (re.test(context)) return season;
  }
  return null;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Собирает все ссылки на PDF со страницы. Ведомство/сезон — из ближайшего
 * предшествующего заголовка (h1-h4) и текста самой ссылки; не нашли — null.
 */
export function extractPassportLinks(html: string, baseUrl: string): PassportLink[] {
  const links: PassportLink[] = [];
  const seen = new Set<string>();

  // Позиции заголовков — контекст секции для каждой ссылки
  const headings: Array<{ index: number; text: string }> = [];
  const headingRe = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(html)) !== null) {
    headings.push({ index: hm.index, text: stripTags(hm[2]) });
  }

  const anchorRe = /<a\s[^>]*href="([^"]+\.pdf[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(html)) !== null) {
    const href = am[1];
    const text = stripTags(am[2]);
    if (!text) continue;

    let pdfUrl: string;
    try {
      pdfUrl = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(pdfUrl)) continue;
    seen.add(pdfUrl);

    // Ближайший заголовок выше ссылки
    let sectionText = '';
    for (const h of headings) {
      if (h.index < am.index) sectionText = h.text;
      else break;
    }
    const context = `${sectionText} ${text}`;

    links.push({
      title: text,
      pdfUrl,
      agency: detectAgency(context),
      season: detectSeason(context),
    });
  }

  return links;
}

// ── Нормализация названий и маппинг ──────────────────────────────────────

const STOP_WORDS = new Set([
  'маршрут', 'маршрута', 'тур', 'экскурсия', 'восхождение', 'поход',
  'пеший', 'пешеходный', 'паспорт', 'туристский', 'туристический',
  'на', 'к', 'по', 'в', 'до', 'из', 'и', 'с',
]);

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/["«»„“().,:;!?№—–-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !STOP_WORDS.has(w))
    .join(' ')
    .trim();
}

/**
 * Консервативный маппинг паспорта на существующие маршруты:
 * - matched — РОВНО один маршрут с точным совпадением нормализованных названий;
 * - ambiguous — несколько точных кандидатов ИЛИ только частичные совпадения
 *   (вхождение одного нормализованного названия в другое) — НЕ автопривязывать;
 * - new — кандидатов нет вовсе.
 */
export function mapPassportToRoutes(
  passportTitle: string,
  routes: RouteCandidate[],
): MappingOutcome {
  const norm = normalizeTitle(passportTitle);
  if (!norm) return { kind: 'new' };

  const exact = routes.filter(r => normalizeTitle(r.title) === norm);
  if (exact.length === 1) return { kind: 'matched', route: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };

  // Частичное совпадение — только в ambiguous, никогда в matched
  const partial = routes.filter(r => {
    const rn = normalizeTitle(r.title);
    if (!rn) return false;
    return rn.includes(norm) || norm.includes(rn);
  });
  if (partial.length > 0) return { kind: 'ambiguous', candidates: partial.slice(0, 5) };

  return { kind: 'new' };
}
