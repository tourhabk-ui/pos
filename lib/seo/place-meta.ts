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
import { placeZoneLabel, routeSeasonLabel } from '@/lib/places/zone-labels';

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
  /**
   * Ближайшие места — тем же списком и расстоянием, что блок «Рядом» карточки
   * (lib/places/nearby). Добирают описание, когда очерка нет.
   */
  nearby?: ReadonlyArray<{ name: string; km: number }>;
  /** Координаты места (у места они обязательны) — последний запас фактов. */
  lat?: number | null;
  lng?: number | null;
  /**
   * Сколько туров витрины идут к месту (главное место или точка пути —
   * lib/places/place-tours, тот же отбор, что блок «Туры к этому месту»).
   * null / не передано — не прочитано: слова «туры» в заголовке нет (§4.0).
   */
  toursCount?: number | null;
}

/**
 * Короче этого сниппет поисковик дописывает сам — кусками страницы (порог
 * переписи sitemap, `dlen`).
 */
export const PLACE_DESCRIPTION_MIN = 70;

/** Сколько ближайших мест называть в описании — не больше, чем помещается. */
const NEARBY_IN_DESCRIPTION = 3;

function nearbyDistance(km: number): string {
  return km < 1 ? 'меньше километра' : `${Math.round(km)} км`;
}

/** Хвост-умолчание, когда ни один фактический не поместился. */
export const PLACE_TITLE_FALLBACK = ' — место на Камчатке';

/** Из каких ответов складывается хвост заголовка места. */
export function placeTitleTopics(f: Pick<PlaceMetaFacts, 'bestSeason' | 'hazardsRecorded' | 'registrationRequired' | 'toursCount'>): string[] {
  // «туры» — первым: этим словом люди ищут место (план продвижения 10.11:
  // «Авачинский тур», «Курильское озеро экскурсия»), а блок туров на карточке
  // есть. Только когда туры к месту на витрине действительно есть.
  const topics = (f.toursCount ?? 0) > 0 ? ['туры', 'как добраться'] : ['как добраться'];
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
  const withTours = topics[0] === 'туры';
  const rest = withTours ? topics.slice(1) : topics;
  const tails = [
    `: ${topics.join(', ')}`,
    ...(withTours ? [': туры и как добраться', ': туры'] : []),
    ...(rest.length > 1 ? [': как добраться и что знать'] : []),
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
  // Код зоны — подписью или никак (04.10, Кайныран: «…на Камчатке, avachinsky.»).
  const zoneLabel = placeZoneLabel(f.zone);
  const where = zoneLabel ? `, ${zoneLabel}` : '';
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
  if (essence.length >= 30) return metaDescription(`${factsText} ${essence}`, max);
  return metaDescription(withCardFacts(factsText, f, max), max);
}

/**
 * Очерка нет — описание добирается тем, что есть на карточке, а не сочиняется
 * (14.10). У 111 мест описание снято как путевая заметка (миграция 1247) и
 * переписывается по источникам; до этого сниппет был одной фразой «Моржовый —
 * мыс на Камчатке, Авачинский.» — 43 знака, и поисковик дописывал его сам.
 * Сначала «Рядом» — местами, которые карточка и так называет, с теми же
 * километрами; не хватило до порога — координаты.
 */
function withCardFacts(factsText: string, f: PlaceMetaFacts, max: number): string {
  let text = factsText;
  const near: string[] = [];
  for (const n of (f.nearby ?? []).slice(0, NEARBY_IN_DESCRIPTION)) {
    const candidate = [...near, `${n.name.trim()} — ${nearbyDistance(n.km)}`];
    if (`${factsText} Рядом: ${candidate.join(', ')}.`.length > max) break;
    near.push(candidate[candidate.length - 1]);
  }
  if (near.length > 0) text = `${factsText} Рядом: ${near.join(', ')}.`;
  if (text.length < PLACE_DESCRIPTION_MIN && f.lat != null && f.lng != null
      && Number.isFinite(f.lat) && Number.isFinite(f.lng)) {
    const coords = ` Координаты: ${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}.`;
    if (text.length + coords.length <= max) text += coords;
  }
  return text;
}

export interface RouteMetaFacts {
  title: string;
  zone: string | null;
  distanceKm: number | null;
  /** Как в паспорте: «в одну сторону» / «в обе стороны». Нет — только число. */
  distanceNote?: string | null;
  durationHours: number | null;
  durationDays: number | null;
  elevationGainM: number | null;
  /** easy / medium / hard или свободный текст источника. */
  difficulty: string | null;
  season: string | null;
  mchsRequired: boolean;
  description: string | null;
  /** Охраняемая территория маршрута (kamchatka_routes.park_name), как на карточке. */
  parkName?: string | null;
  /** Высшая точка трека, м (kamchatka_routes.elevation_max_m). */
  elevationMaxM?: number | null;
}

/**
 * Сниппет короче этого — «короткий» (замечание Сыщика 21.11): его добирают
 * поля записи — территория и высшая точка трека. Только поля, ничего от себя.
 */
export const ROUTE_DESCRIPTION_SHORT = 120;

const DIFFICULTY_RU: Record<string, string> = {
  easy: 'лёгкая', medium: 'средняя', hard: 'сложная', extreme: 'экстремальная',
};


function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
}

/** Факты маршрута одной строкой: «12 км · набор 700 м · 6 ч · сложность средняя · сезон лето». */
export function routeFactsLine(f: RouteMetaFacts): string {
  const parts: string[] = [];
  if (f.distanceKm != null && f.distanceKm > 0) {
    const note = (f.distanceNote ?? '').trim();
    parts.push(note ? `${fmtNum(f.distanceKm)} км ${note}` : `${fmtNum(f.distanceKm)} км`);
  }
  if (f.elevationGainM != null && f.elevationGainM > 0) parts.push(`набор ${Math.round(f.elevationGainM)} м`);
  if (f.durationDays != null && f.durationDays > 1) parts.push(`${f.durationDays} дн.`);
  else if (f.durationHours != null && f.durationHours > 0) parts.push(`${fmtNum(f.durationHours)} ч`);
  if (f.difficulty) parts.push(`сложность ${DIFFICULTY_RU[f.difficulty] ?? f.difficulty.toLowerCase()}`);
  // Сезон бывает списком («summer, autumn» — payloadText склеивает массив): переводится каждый.
  // Код без перевода (`all` импорта, #3568) не печатается: «сезон all» — не сезон.
  const season = routeSeasonLabel(f.season);
  if (season) parts.push(`сезон ${season.toLowerCase()}`);
  return parts.join(' · ');
}

/**
 * Начало сниппета — с названия маршрута (SEO-аудит 20.11.2026). Прежде все
 * маршруты начинались одинаково: «Маршрут на Камчатке: 19,6 км · набор 901 м
 * · сложность средняя.» — у 188 страниц, у 162 из них этим сниппет и
 * кончался (описания нет). Для поисковика это шаблон, для человека — ни
 * слова о том, куда маршрут. Название — поле записи, не сочинительство.
 *
 * «Озеро Зелёное — маршрут, Авачинский: …»; без района — «… — маршрут на
 * Камчатке: …». Название уже начинается со слова «маршрут» — район в
 * скобках, без повтора: «Маршрут на вулкан Дыгерен (Западная Камчатка): …».
 */
export function routeDescriptionHead(title: string | null | undefined, zoneLabel: string | null, facts: string): string {
  const name = (title ?? '').replace(/\s+/g, ' ').trim().replace(/[.:;,\s]+$/, '');
  const tail = facts ? `: ${facts}.` : '.';
  if (!name) return `Маршрут на Камчатке${zoneLabel ? `, ${zoneLabel}` : ''}${tail}`;
  if (/^маршрут/i.test(name)) return `${name}${zoneLabel ? ` (${zoneLabel})` : ''}${tail}`;
  return `${name} — маршрут${zoneLabel ? `, ${zoneLabel}` : ' на Камчатке'}${tail}`;
}

export function routeDescription(f: RouteMetaFacts, max: number = META_DESCRIPTION_MAX): string {
  // Код зоны — подписью или никак (04.10, Кайныран: «…на Камчатке, avachinsky.»).
  const zoneLabel = placeZoneLabel(f.zone);
  const mchs = f.mchsRequired ? ' Регистрация в МЧС обязательна.' : '';
  const compose = (facts: string): { text: string; rest: string } => {
    const factsText = `${routeDescriptionHead(f.title, zoneLabel, facts)}${mchs}`;
    const rest = f.description ? metaDescription(f.description, Math.max(0, max - factsText.length - 1)) : '';
    return { text: rest.length >= 30 ? `${factsText} ${rest}` : factsText, rest };
  };
  let out = compose(routeFactsLine(f));
  // С названием впереди полная строка фактов может съесть место под начало
  // описания. Описание есть, а не влезло — факты короче: длина и сложность
  // (аудит 20.11: «название, район, длина, сложность, начало описания»).
  if (f.description && out.rest.length < 30) {
    const compact = compose(routeFactsLine({ ...f, elevationGainM: null, durationHours: null, durationDays: null, season: null }));
    if (compact.rest.length >= 30) out = compact;
  }
  return metaDescription(withRouteRecordFacts(out.text, out.rest, f, max), max);
}

/**
 * Короткий сниппет (описания нет или от него остался обрывок) добирается
 * живыми полями записи маршрута — территорией и высшей точкой трека, если они
 * записаны. Поля нет — ничего не добавляется; название территории, уже
 * стоящее в названии маршрута, не повторяется. Каждая добавка — целиком или
 * никак: обрубок «Территория: Природный па…» хуже короткой строки.
 */
function withRouteRecordFacts(text: string, rest: string, f: RouteMetaFacts, max: number): string {
  if (rest.length >= 30 || text.length >= ROUTE_DESCRIPTION_SHORT) return text;
  const extras: string[] = [];
  const park = (f.parkName ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (park && !(f.title ?? '').toLowerCase().includes(park.toLowerCase())) {
    extras.push(`Территория: ${park}.`);
  }
  if (f.elevationMaxM != null && Number.isFinite(f.elevationMaxM) && f.elevationMaxM > 0) {
    extras.push(`Высшая точка: ${Math.round(f.elevationMaxM)} м.`);
  }
  let out = text;
  for (const e of extras) {
    if (out.length + 1 + e.length <= max) out = `${out} ${e}`;
  }
  return out;
}
