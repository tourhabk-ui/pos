/**
 * Зона планера по месту сводки (вулкан, округ, посёлок) — одна карта для
 * движка плана и страницы /trip (слово владельца 22.11: «Ключевской» вверху
 * плана, где Северной зоны нет). Нет привязки — пусто: зону не угадываем.
 * Чистый модуль без lookbehind — он доходит до клиента.
 *
 * Зона по названию — только запасной путь. Первым судит то, что записала
 * сама лента: `external_alerts.affected_zones` (ревью безопасности #3690,
 * 22.11). По названию «Усть-Большерецк» — Западная, а сводка о дороге
 * «Начикинский совхоз — Усть-Большерецк» записана и на Авачинскую; по
 * заголовку «… км от Петропавловска-Камчатского» — Авачинская, а эпицентр
 * на севере. Догадка по имени прятала обе сводки от плана, которого они
 * касаются (`alertTouchesPlanZones`).
 */
import { alertZonesOf, type ZoneId } from '@/lib/planner/constants';

const PLAN_ZONE_BY_PLACE: Array<[RegExp, string]> = [
  [/шивелуч|ключевск|безымянн|толбачик|усть-камчатск|мильков/, 'northern'],
  [/крашенинников|карымск|кроноцк/, 'eastern'],
  [/авачинск|корякск|мутновск|горелый|вилючинск|елизов|петропавловск/, 'avachinsky'],
  [/ичинск|усть-большерецк|левашов|соболев|быстринск/, 'western'],
];

export function placeZones(place: string): string[] {
  const p = place.toLowerCase().replace(/ё/g, 'е');
  const zones = new Set<string>();
  for (const [re, zone] of PLAN_ZONE_BY_PLACE) if (re.test(p)) zones.add(zone);
  return [...zones];
}

/**
 * Касается ли сводка о месте зон плана: место привязано к зоне плана — да;
 * привязано только к чужим зонам — нет; не привязано вовсе — да (молчать о
 * сводке, зону которой не знаем, нельзя).
 */
export function placeTouchesZones(place: string, planZones: readonly string[]): boolean {
  const z = placeZones(place);
  return z.length === 0 || z.some((x) => planZones.includes(x));
}

const PLAN_ZONE_IDS: ReadonlySet<string> = new Set(['avachinsky', 'western', 'eastern', 'northern', 'southern']);

/**
 * Метки охвата в `affected_zones`, которые не совпадают с зоной планера, —
 * в зоны планера. «Юг края до Петропавловска» (`krai_south`, решение
 * владельца 04.10) задевает южную, Авачинскую и Западную: охват там широтой,
 * а не зоной, и сузить его по зоне значило бы спрятать. Дальние метки
 * (`krai_koryak`, `krai_commander`, `kuril_north`) сюда не входят: ни одной
 * зоны планера они не задевают, и сводка судится запасным путём, по имени.
 */
const PLAN_ZONES_BY_LABEL: Readonly<Record<string, readonly string[]>> = {
  krai_south: ['southern', 'avachinsky', 'western'],
};

/**
 * Зоны планера, записанные лентой для сводки. null — зон нет или ни одна не
 * переводится в зону планера: тогда судит название (`placeTouchesZones`).
 */
export function recordedPlanZones(recorded: readonly string[] | null | undefined): string[] | null {
  if (!Array.isArray(recorded) || recorded.length === 0) return null;
  const out = new Set<string>();
  for (const raw of recorded) {
    if (typeof raw !== 'string') continue;
    if (PLAN_ZONE_IDS.has(raw)) out.add(raw);
    for (const z of PLAN_ZONES_BY_LABEL[raw] ?? []) out.add(z);
  }
  return out.size > 0 ? [...out] : null;
}

/**
 * Зоны тревог плана: день южной зоны получает и тревоги Западной — то же
 * правило, что у дня плана (`alertZonesOf`).
 */
export function planAlertZones(planZones: readonly string[]): string[] {
  const out = new Set<string>();
  for (const z of planZones) {
    out.add(z);
    if (PLAN_ZONE_IDS.has(z)) for (const x of alertZonesOf(z as ZoneId)) out.add(x);
  }
  return [...out];
}

/**
 * Касается ли сводка зон плана. Записанные лентой зоны — первыми; их нет —
 * название места (`placeTouchesZones`, с его «не знаем — показываем»).
 */
export function alertTouchesPlanZones(
  recorded: readonly string[] | null | undefined,
  label: string,
  planZones: readonly string[],
): boolean {
  const plan = planAlertZones(planZones);
  const zones = recordedPlanZones(recorded);
  return zones ? zones.some((z) => plan.includes(z)) : placeTouchesZones(label, plan);
}

/** Шапка /trip: по краю сводки есть, ни одна не названа для зон плана. */
export const PLAN_HEADER_NO_MATCH =
  'Сводки по краю есть, для зон этого плана ни одна не названа — данные safety-мониторинга платформы';

/**
 * Строка обстановки в шапке /trip по ответу `/api/public/safety-status`.
 * null — данных нет или источник недоступен (блока нет, а не «спокойно»).
 *
 * Сводка выбирается по районам, которые записала лента (`feedZones`,
 * `topZones`), а без них — по заголовку. Тревога в крае остаётся тревогой:
 * до ревью #3690 шапка, не найдя сводки о зонах плана по догадке из
 * заголовка, переворачивала `hasAlert: true` в зелёную галочку «сводок нет».
 * Теперь — значок тревоги и слова, что для зон плана ни одна не названа.
 */
export function planHeaderStatus(
  payload: unknown,
  planZones: readonly string[],
): { title: string | null; hasAlert: boolean } | null {
  const data = (payload as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== 'object') return null;
  if (data.unavailable === true) return null;
  const hasAlert = data.hasAlert === true;
  const topTitle = typeof data.topTitle === 'string' ? data.topTitle : null;
  if (planZones.length === 0) return { title: topTitle, hasAlert };

  const strList = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  const titles = Array.isArray(data.feedTitles) ? data.feedTitles : [];
  // Районы ленты выровнены по индексу с заголовками; другой длины — не
  // доверяем выравниванию и судим по заголовку.
  const zonesList = Array.isArray(data.feedZones) && data.feedZones.length === titles.length ? data.feedZones : null;
  const candidates: Array<{ title: string; zones: string[] | null }> = [];
  titles.forEach((t, i) => {
    if (typeof t === 'string') candidates.push({ title: t, zones: zonesList ? strList(zonesList[i]) : null });
  });
  if (topTitle) candidates.push({ title: topTitle, zones: strList(data.topZones) });

  const hit = candidates.find((c) => alertTouchesPlanZones(c.zones, c.title, planZones));
  if (hit) return { title: hit.title, hasAlert };
  return hasAlert ? { title: PLAN_HEADER_NO_MATCH, hasAlert: true } : { title: null, hasAlert: false };
}
