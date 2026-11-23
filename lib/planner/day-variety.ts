/**
 * Разнообразие дней плана (симптом владельца 23.11 и разбор 17 программ
 * операторов на 6–10 дней).
 *
 * Это не загрузка мест. Правило такое:
 * - одну тему и одну точку не ставят день за днём;
 * - полный день на источниках — обычно один за поездку; купание чаще вечер
 *   другого дня, и вторым полным днём его не делаем;
 * - многодневный тур на источниках (как пятидневный термальный) в основу
 *   автоплана не ставится: его не режут и не теряют молча, а называют
 *   альтернативой. Многодневный тур другой темы, который поездка вмещает
 *   и которого ещё не ставили, остаётся одним продуктом — его не режут;
 * - разные выезды одного типа (снегоход в разные точки) — до трёх за неделю
 *   поездки до 10 дней, не подряд;
 * - зимние пустые дни набираются из каталога тем, что там есть: океан,
 *   музей, этно, природа. Чего в каталоге нет — в план не дописывается.
 */

import { ACTIVITY_NAMES } from '@/lib/planner/constants';

const ALIAS: Record<string, string> = { thermal: 'hot_spring' };

const MUSEUM = new Set(['museum', 'historical']);
const ETHNO = new Set(['ethnic']);
const OCEAN = new Set(['bay', 'cape']);
const NATURE = new Set(['viewpoint', 'park', 'beach', 'waterfall', 'settlement', 'lake']);

/** Ключ категории дня. Источники — один ключ на оба слова оператора. */
export function varietyKey(type: string | null | undefined): string {
  const t = (type ?? '').trim();
  return ALIAS[t] ?? t;
}

/** Тип места каталога → категория самостоятельного дня. */
export function placeVarietyKey(locationType: string | null | undefined): string {
  const t = (locationType ?? '').trim();
  if (t === 'hot_spring' || t === 'thermal') return 'hot_spring';
  if (MUSEUM.has(t)) return 'museum';
  if (ETHNO.has(t)) return 'ethno';
  if (OCEAN.has(t)) return 'ocean';
  if (NATURE.has(t)) return 'nature';
  return t || 'nature';
}

export function varietyWord(key: string): string {
  if (key === 'hot_spring') return 'источники';
  if (key === 'museum') return 'музей';
  if (key === 'ethno') return 'этно';
  if (key === 'ocean') return 'океан';
  if (key === 'nature') return 'природа';
  return ACTIVITY_NAMES[key] ?? key;
}

/**
 * Сколько выездов одной темы за поездку. Источники — один полный день.
 * Остальное — два–три за неделю: в программе до 10 дней потолок три,
 * дальше ещё один на каждую полную неделю сверх десяти.
 */
export function outingCap(tripDays: number, key: string): number {
  if (varietyKey(key) === 'hot_spring') return 1;
  const days = tripDays > 0 ? tripDays : 7;
  if (days <= 10) return 3;
  return 3 + Math.floor((days - 10) / 7);
}

export type VarietyDeny = 'long' | 'row' | 'cap';

export interface VarietyLedger {
  counts: Map<string, number>;
  /** Категория предыдущего поставленного дня. Свободный день её сбрасывает. */
  previous: string | null;
  /** Точка предыдущего дня. Ту же точку подряд не ставим. */
  previousPlace: string | null;
}

export function emptyLedger(): VarietyLedger {
  return { counts: new Map(), previous: null, previousPlace: null };
}

export function noteVariety(ledger: VarietyLedger, key: string, span: number, placeId?: string | null): void {
  ledger.counts.set(key, (ledger.counts.get(key) ?? 0) + span);
  ledger.previous = key;
  ledger.previousPlace = placeId ?? null;
}

/** День без этой категории: следующий день той же категории уже не «подряд». */
export function noteGap(ledger: VarietyLedger): void {
  ledger.previous = null;
  ledger.previousPlace = null;
}

/**
 * Можно ли поставить `span` дней категории.
 * Многодневный тур на источниках в основу не ставится. Один многодневный
 * продукт другой темы, когда этой темы в плане ещё нет, — это сам тур,
 * а не несколько выездов: потолок «два–три за неделю» его не режет.
 */
export function varietyAdmit(
  daysAlready: number,
  previousKey: string | null,
  key: string,
  span: number,
  tripDays: number,
  previousPlace: string | null = null,
  placeId: string | null = null,
): { ok: true } | { ok: false; kind: VarietyDeny; reason: string } {
  const word = varietyWord(key);
  const days = span > 0 ? span : 1;
  const cap = outingCap(tripDays, key);
  if (days > 1 && key === 'hot_spring') {
    return {
      ok: false,
      kind: 'long',
      reason: `${days} дн. одной темы «${word}»: в основу автоплана такой тур не ставим, резать его нельзя`,
    };
  }
  if (previousKey === key || (placeId !== null && previousPlace !== null && placeId === previousPlace)) {
    return { ok: false, kind: 'row', reason: `день категории «${word}» шёл бы подряд с предыдущим` };
  }
  if (daysAlready + days > cap && !(days > 1 && daysAlready === 0)) {
    return {
      ok: false,
      kind: 'cap',
      reason: key === 'hot_spring'
        ? 'полный день на источниках в поездке уже есть'
        : `категории «${word}» уже ${daysAlready} дн. из ${cap} за эту поездку`,
    };
  }
  return { ok: true };
}

export function longTourSkippedLine(title: string, span: number, key: string): string {
  return `«${title}» — ${span} дн. Туры продают целиком, резать его нельзя. `
    + `В основу автоплана многодневный тур одной темы (${varietyWord(key)}) не ставим: `
    + 'его можно взять вместо этих дней, если хотите именно его.';
}

export function capSkippedLine(key: string): string {
  if (key === 'hot_spring') {
    return 'Ещё полный день на источниках не ставили: такой день в поездке обычно один. '
      + 'Купание чаще бывает вечером другого дня, отдельным днём его не считаем.';
  }
  return `Ещё дни категории «${varietyWord(key)}» не ставили: одной темы не больше двух–трёх выездов за неделю и не подряд.`;
}

const PLACE_ORDER = ['ocean', 'museum', 'ethno', 'nature', 'hot_spring'];

/** Место каталога, которое правило разнообразия пускает на этот день. Пул пуст — null, место не выдумывается. */
export function pickVariedPlace<T extends { type: string; href: string }>(
  pool: readonly T[],
  ledger: VarietyLedger,
  taken: ReadonlySet<string>,
  tripDays = 7,
): T | null {
  const candidates = pool.filter((p) => !taken.has(p.href));
  const ranked = [...candidates].sort((a, b) => {
    const ka = placeVarietyKey(a.type);
    const kb = placeVarietyKey(b.type);
    const ca = ledger.counts.get(ka) ?? 0;
    const cb = ledger.counts.get(kb) ?? 0;
    if (ca !== cb) return ca - cb;
    const ia = PLACE_ORDER.indexOf(ka);
    const ib = PLACE_ORDER.indexOf(kb);
    return (ia < 0 ? PLACE_ORDER.length : ia) - (ib < 0 ? PLACE_ORDER.length : ib);
  });
  for (const place of ranked) {
    const key = placeVarietyKey(place.type);
    const admit = varietyAdmit(
      ledger.counts.get(key) ?? 0, ledger.previous, key, 1, tripDays, ledger.previousPlace, place.href,
    );
    if (admit.ok) return place;
  }
  return null;
}
