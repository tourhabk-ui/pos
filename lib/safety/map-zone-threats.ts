/**
 * «Угрозы по районам» на полевой карте (#2930, поправка плана 10.11).
 *
 * Плашка карты называет число тревог в крае и верхнюю строку. Какой район они
 * касаются, человек с картой узнать не мог: разбивка жила на /safety. Здесь —
 * правило разбивки, без запросов: та же лента сайта (`getCurrentSafetyStatus`,
 * районы пунктов — `feedZones`) и расчётная оценка зон
 * (`/api/public/danger-summary`). Своего отбора тревог нет — лента одна.
 *
 * Правила:
 *  - район пункта — как его назвала сводка (`affected_zones`). Пункт без
 *    района идёт строкой «район в сводке не указан», а не во все районы:
 *    «не установлено» ≠ «везде» (то же правило, что у мест, 27.09);
 *  - пункт, назвавший все четыре зоны, — «по всему краю», а не четыре копии;
 *  - метки охвата (юг до Петропавловска, Корякский округ, Командоры, Северные
 *    Курилы) — своими строками, только когда их назвал пункт;
 *  - у района три исхода (§4.0): тревоги / «тревог в ленте нет» / неизвестно.
 *    Неизвестно — лента не прочиталась или пришла без районов: тогда ни один
 *    район не называется тихим. «Тревог в ленте нет» — не «безопасно»:
 *    расчётная оценка зоны идёт рядом своей строкой и состояния не меняет —
 *    она расчётная, а не сводка;
 *  - полигонов нет: границ у зон в данных нет, нарисованная граница была бы
 *    обещанием без источника (§12).
 *
 * Сторож — вызов на граничных данных: tests/unit/map-zone-threats.test.ts.
 */
import { ALERT_ZONES } from '@/lib/safety/alert-zones';
import { ZONE_NAMES, zoneName } from '@/lib/safety/zone-names';
import { ZONE_RISK_LABELS } from '@/lib/safety/severity-words';

/** Лента из ответа `/api/public/safety-status` — то, что нужно разбивке. */
export interface FeedPayload {
  unavailable?: boolean;
  feedCount?: number | null;
  feedTitles?: string[] | null;
  feedZones?: string[][] | null;
}

/** Ответ `/api/public/danger-summary`. */
export interface DangerSummaryPayload {
  ok?: boolean;
  zones?: Array<{ zone: string; risk_level: string }>;
}

export type DistrictState = 'alert' | 'quiet' | 'unknown';

export interface District {
  zone: string;
  name: string;
  state: DistrictState;
  /** Пункты ленты, назвавшие этот район. */
  alerts: string[];
  /** Расчётная оценка словами; null — оценки по зоне нет или она не прочиталась. */
  risk: string | null;
}

export interface ZoneThreats {
  /** false — лента не прочиталась: ни один район не назван тихим. */
  feedKnown: boolean;
  /** false — оценка зон не прочиталась (это не «оценка — норма»). */
  riskKnown: boolean;
  /** Пункты, назвавшие все четыре зоны. */
  kraiWide: string[];
  districts: District[];
  /** Пункты без района в сводке. */
  unzoned: string[];
  /** Пунктов в ленте больше, чем пришло с районами: остальные — на /safety. */
  more: number;
}

/** Есть ли у слага имя: незнакомый слаг человеку не показывается. */
function isNamedZone(z: string): boolean {
  return zoneName(z) !== z;
}

function feedOf(p: FeedPayload | null): Array<{ title: string; zones: string[] }> | null {
  if (!p || p.unavailable === true) return null;
  const titles = p.feedTitles;
  const zones = p.feedZones;
  if (!Array.isArray(titles) || !Array.isArray(zones) || zones.length !== titles.length) return null;
  return titles.map((title, i) => ({ title, zones: Array.isArray(zones[i]) ? zones[i] : [] }));
}

export function mapZoneThreats(feedPayload: FeedPayload | null, danger: DangerSummaryPayload | null): ZoneThreats {
  const feed = feedOf(feedPayload);
  const riskKnown = Boolean(danger && danger.ok !== false && Array.isArray(danger.zones));
  const riskOf = (zone: string): string | null => {
    if (!riskKnown) return null;
    const row = danger!.zones!.find((z) => z.zone === zone);
    return row ? (ZONE_RISK_LABELS[row.risk_level] ?? null) : null;
  };

  const order: string[] = [...ALERT_ZONES];
  const byZone = new Map<string, string[]>(order.map((z) => [z, []]));
  const kraiWide: string[] = [];
  const unzoned: string[] = [];

  for (const item of feed ?? []) {
    const named = [...new Set(item.zones.filter(isNamedZone))];
    if (named.length === 0) { unzoned.push(item.title); continue; }
    if (ALERT_ZONES.every((z) => named.includes(z))) { kraiWide.push(item.title); continue; }
    for (const z of named) {
      if (!byZone.has(z)) { byZone.set(z, []); order.push(z); }
      byZone.get(z)!.push(item.title);
    }
  }

  const districts: District[] = order.map((zone) => {
    const alerts = byZone.get(zone) ?? [];
    const state: DistrictState = feed === null ? 'unknown' : alerts.length > 0 ? 'alert' : 'quiet';
    return { zone, name: ZONE_NAMES[zone] ?? zoneName(zone), state, alerts, risk: riskOf(zone) };
  });

  const count = typeof feedPayload?.feedCount === 'number' ? feedPayload.feedCount : 0;
  return {
    feedKnown: feed !== null,
    riskKnown,
    kraiWide,
    districts,
    unzoned,
    more: feed === null ? 0 : Math.max(0, count - feed.length),
  };
}

/** Строка состояния района словами. */
export function districtStateLine(d: District): string {
  if (d.state === 'unknown') return 'неизвестно — лента тревог не прочиталась';
  if (d.state === 'quiet') return 'тревог в ленте нет';
  return d.alerts.length === 1 ? '1 тревога' : `тревог: ${d.alerts.length}`;
}
