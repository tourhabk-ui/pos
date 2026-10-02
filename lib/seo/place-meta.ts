/**
 * Заголовок и описание карточек места и маршрута для поиска — из ФАКТОВ.
 *
 * Срез 02.10 (публичные сигналы, без Search Console): у «Долины гейзеров»
 * title «Долина гейзеров — место на Камчатке» и description из первой фразы
 * очерка («Я спускался в каньон…», 73 знака). Запрос человека звучит иначе:
 * «как добраться», «сезон», «опасно ли», «нужна ли регистрация». Карточка на
 * эти вопросы отвечает блоками «Как добраться», «Сейчас», «Что знать» — а
 * заголовок и сниппет об этом молчали, и в выдаче место проигрывало
 * Википедии и туроператорам.
 *
 * Правило §4.0 здесь главное: в заголовок попадает только то, чем карточка
 * располагает. «Сезон» — если сезон записан; «опасности» — если профиль
 * безопасности их знает или требует регистрацию в МЧС; «как добраться» —
 * всегда, потому что автопуть и пеший путь строятся по координатам, а они у
 * места обязательны. Описание собирается из тех же фактов, и лишь остаток
 * места добирается очерком. Пустые факты не выдумываются: нет сезона — нет
 * слова «сезон».
 */
import { TITLE_LIMIT, BRAND_SUFFIX } from '@/lib/seo/title-fit';
import { metaDescription, META_DESCRIPTION_MAX } from '@/lib/seo/meta-description';

export interface PlaceMetaFacts {
  name: string;
  /** Подпись типа строчными («вулкан», «озеро»); «место» — тип не записан. */
  typeLabel: string | null;
  zone: string | null;
  bestSeason: string | null;
  altitudeM: number | null;
  /** Профиль безопасности знает опасности этого места (измеренные, не шаблон). */
  hazardsRecorded: boolean;
  registrationRequired: boolean;
  /** Реалтайм-статус: закрыто сейчас. null — не записано. */
  isOpen: boolean | null;
  /** Очерк/описание — добирает описание до предела, не сочиняя. */
  essence: string | null;
}

/** Хвост-умолчание, когда ни один фактический не поместился. */
export const PLACE_TITLE_FALLBACK = ' — место на Камчатке';

/** Из каких ответов складывается хвост заголовка места. */
export function placeTitleTopics(f: Pick<PlaceMetaFacts, 'bestSeason' | 'hazardsRecorded' | 'registrationRequired'>): string[] {
  const topics = ['как добраться'];
  if (f.bestSeason) topics.push('сезон');
  if (f.hazardsRecorded || f.registrationRequired) topics.push('опасности');
  return topics;
}

/**
 * Хвосты — по ПРИОРИТЕТУ, не по длине (в отличие от fitTitle): ответ на
 * запрос важнее слова «место», даже если то длиннее и тоже помещается.
 * Не поместился ни один — имя без хвоста.
 */
export function placeTitle(f: PlaceMetaFacts, limit: number = TITLE_LIMIT): string {
  const topics = placeTitleTopics(f);
  const tails = [
    `: ${topics.join(', ')}`,
    ...(topics.length > 1 ? [': как добраться и что знать'] : []),
    ': как добраться',
    PLACE_TITLE_FALLBACK,
  ];
  const room = limit - BRAND_SUFFIX.length - f.name.length;
  return f.name + (tails.find(t => t.length <= room) ?? '');
}

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/**
 * Описание: сначала факты, потом очерк — пока помещается. Режется тем же
 * правилом, что и прежде (по предложению или слову, не посреди слова).
 */
export function placeDescription(f: PlaceMetaFacts, max: number = META_DESCRIPTION_MAX): string {
  const type = f.typeLabel && f.typeLabel !== 'место' ? f.typeLabel : null;
  const where = f.zone ? `, ${f.zone.trim()}` : '';
  const facts: string[] = [
    type ? `${f.name} — ${type} на Камчатке${where}.` : `${f.name} — место на Камчатке${where}.`,
  ];
  if (f.altitudeM != null && f.altitudeM > 0) facts.push(`Высота ${Math.round(f.altitudeM)} м.`);
  if (f.bestSeason) facts.push(sentence(`Сезон: ${f.bestSeason}`));
  if (f.isOpen === false) facts.push('Сейчас закрыто.');
  if (f.registrationRequired) facts.push('Нужна регистрация в МЧС.');
  const factsText = facts.join(' ');
  const essence = f.essence ? metaDescription(f.essence, Math.max(0, max - factsText.length - 1)) : '';
  // Очерк короче 30 знаков — обрывок, а не фраза; без него честнее.
  const withEssence = essence.length >= 30 ? `${factsText} ${essence}` : factsText;
  return metaDescription(withEssence, max);
}

export interface RouteMetaFacts {
  title: string;
  zone: string | null;
  distanceKm: number | null;
  durationHours: number | null;
  durationDays: number | null;
  elevationGainM: number | null;
  /** easy / medium / hard или свободный текст источника. */
  difficulty: string | null;
  season: string | null;
  mchsRequired: boolean;
  description: string | null;
}

const DIFFICULTY_RU: Record<string, string> = {
  easy: 'лёгкая', medium: 'средняя', hard: 'сложная', extreme: 'экстремальная',
};

const SEASON_RU: Record<string, string> = {
  summer: 'лето', winter: 'зима', all: 'круглый год', spring: 'весна', autumn: 'осень',
};

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
}

/** Факты маршрута одной строкой: «12 км · набор 700 м · 6 ч · сложность средняя · сезон лето». */
export function routeFactsLine(f: RouteMetaFacts): string {
  const parts: string[] = [];
  if (f.distanceKm != null && f.distanceKm > 0) parts.push(`${fmtNum(f.distanceKm)} км`);
  if (f.elevationGainM != null && f.elevationGainM > 0) parts.push(`набор ${Math.round(f.elevationGainM)} м`);
  if (f.durationDays != null && f.durationDays > 1) parts.push(`${f.durationDays} дн.`);
  else if (f.durationHours != null && f.durationHours > 0) parts.push(`${fmtNum(f.durationHours)} ч`);
  if (f.difficulty) parts.push(`сложность ${DIFFICULTY_RU[f.difficulty] ?? f.difficulty.toLowerCase()}`);
  if (f.season) parts.push(`сезон ${SEASON_RU[f.season] ?? f.season.toLowerCase()}`);
  return parts.join(' · ');
}

export function routeDescription(f: RouteMetaFacts, max: number = META_DESCRIPTION_MAX): string {
  const where = f.zone ? `, ${f.zone.trim()}` : '';
  const facts = routeFactsLine(f);
  const head = facts
    ? `Маршрут на Камчатке${where}: ${facts}.`
    : `Маршрут на Камчатке${where}.`;
  const mchs = f.mchsRequired ? ' Регистрация в МЧС обязательна.' : '';
  const factsText = `${head}${mchs}`;
  const rest = f.description ? metaDescription(f.description, Math.max(0, max - factsText.length - 1)) : '';
  const withRest = rest.length >= 30 ? `${factsText} ${rest}` : factsText;
  return metaDescription(withRest, max);
}
