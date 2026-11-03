/**
 * Предпросмотр изменения цен — K.ai B2. НИЧЕГО НЕ ПИШЕТ.
 *
 * Два рода изменения (решение владельца 03.11):
 *   • weekend_markup — наценка на сб и вс, 1..30%;
 *   • base_price     — «подними всё на 10%»: базовая цена ±1..30%.
 * Цифры «стало» считает тот же движок, что и счёт (`composeHonestPrice`):
 * правила тура, ступени, округление движка — как увидит турист. Новая
 * базовая цена — без округления (владелец: «не округлять»).
 * Пример цены — на ближайшую субботу по Камчатке, один гость.
 */
import { pool } from '@/lib/db-pool';
import { composeHonestPrice, loadPricingContext, type PricingExecutor } from '@/lib/tours/honest-price';
import { markupToMultiplier, MAX_OPERATOR_MARKUP } from '@/lib/tours/operator-discount';
import type { PricingRule } from '@/lib/tours/pricing-rule-match';

export type PriceChange =
  | { kind: 'weekend_markup'; percent: number | null; tourIds: number[] | 'all' }
  | { kind: 'base_price'; percent: number; tourIds: number[] | 'all' };

export interface TourPreview {
  tourId: number;
  title: string;
  baseBefore: number;
  baseAfter: number;
  /** Цена туристу за одного на `sampleDate` — до и после. */
  saturdayBefore: number;
  saturdayAfter: number;
  /** У тура ступени цены по группе: правка базовой цены туристу НЕ видна. */
  tiersOverride: boolean;
}

export interface PricePreview { change: PriceChange; sampleDate: string; tours: TourPreview[] }

export const MAX_BASE_CHANGE = MAX_OPERATOR_MARKUP;

/** Ошибка в самом изменении — текст для человека. null — изменение допустимо. */
export function changeProblem(c: PriceChange): string | null {
  if (c.kind === 'weekend_markup') {
    if (c.percent !== null && markupToMultiplier(c.percent) === null) return `Наценка — целое число от 1 до ${MAX_OPERATOR_MARKUP}%`;
  } else if (!Number.isInteger(c.percent) || c.percent === 0 || Math.abs(c.percent) > MAX_BASE_CHANGE) {
    return `Изменение базовой цены — целое число от 1 до ${MAX_BASE_CHANGE}% вверх или вниз`;
  }
  if (c.tourIds !== 'all' && c.tourIds.length === 0) return 'Не выбран ни один тур';
  return null;
}

/** Новая базовая цена — точно, без округления (до копеек: процент целый). */
export function changedBase(base: number, percent: number): number {
  return Math.round(base * (100 + percent)) / 100;
}

/** Ближайшая суббота (включая сегодня) по времени Камчатки, `YYYY-MM-DD`. */
export function nextSaturday(nowMs: number): string {
  const kam = new Date(nowMs + 12 * 3600_000);
  const add = (6 - kam.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(kam.getUTCFullYear(), kam.getUTCMonth(), kam.getUTCDate() + add)).toISOString().slice(0, 10);
}

function withNewMarkup(rules: PricingRule[], percent: number | null): PricingRule[] {
  const rest = rules.filter((r) => r.rule_type !== 'weekend_sat_sun');
  const m = percent === null ? null : markupToMultiplier(percent);
  return m === null ? rest : [...rest, { rule_type: 'weekend_sat_sun', multiplier: m } as PricingRule];
}

export async function previewPriceChange(
  operatorId: string, change: PriceChange, nowMs: number, db: PricingExecutor = pool,
): Promise<PricePreview> {
  const problem = changeProblem(change);
  if (problem) throw new RangeError(problem);
  const sampleDate = nextSaturday(nowMs);
  const { rows } = await db.query<{ id: number; title: string; base_price: string; price_unit: string | null }>(
    `SELECT id::int AS id, title, base_price, price_unit FROM operator_tours
      WHERE operator_id = $1 AND deleted_at IS NULL AND ($2::int[] IS NULL OR id = ANY($2::int[]))
      ORDER BY title`,
    [operatorId, change.tourIds === 'all' ? null : change.tourIds],
  );
  const tours: TourPreview[] = [];
  for (const t of rows) {
    const base = Number(t.base_price);
    const { rules, occupancyPct, tiers } = await loadPricingContext(t.id, sampleDate, db);
    const ctx = { tourDate: sampleDate, guests: 1, occupancyPct };
    const price = (b: number, r: PricingRule[]) =>
      composeHonestPrice({ baseUnitPrice: b, priceUnit: t.price_unit, participants: 1, rules: r, tiers, ctx }).finalUnitPrice;
    const baseAfter = change.kind === 'base_price' ? changedBase(base, change.percent) : base;
    const rulesAfter = change.kind === 'weekend_markup' ? withNewMarkup(rules, change.percent) : rules;
    let before: number, after: number;
    try { before = price(base, rules); after = price(baseAfter, rulesAfter); } catch { continue; } // группа вне ступеней — цены на одного нет
    tours.push({ tourId: t.id, title: t.title, baseBefore: base, baseAfter, saturdayBefore: before, saturdayAfter: after, tiersOverride: tiers.length > 0 });
  }
  return { change, sampleDate, tours };
}

const rub = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/\u00a0/g, ' ')} ₽`;
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/** Текст предпросмотра для чата. Без личных данных: только туры и цены. */
export function previewText(p: PricePreview): string {
  const c = p.change;
  const head = c.kind === 'weekend_markup'
    ? (c.percent === null ? 'Снять наценку на выходные (сб, вс)' : `Наценка на выходные (сб, вс): +${c.percent}%`)
    : `Базовая цена: ${c.percent > 0 ? '+' : '−'}${Math.abs(c.percent)}%`;
  if (p.tours.length === 0) return `${head}\nТуров для изменения не нашлось.`;
  const lines = p.tours.map((t) => {
    const base = c.kind === 'base_price' ? ` · база ${rub(t.baseBefore)} → ${rub(t.baseAfter)}` : '';
    const warn = t.tiersOverride ? ' (у тура цены по размеру группы — туристу считаются они)' : '';
    return `• ${t.title}${base} · сб ${ddmm(p.sampleDate)}: ${rub(t.saturdayBefore)} → ${rub(t.saturdayAfter)}${warn}`;
  });
  return [head, ...lines, 'Уже оформленные брони не меняются.'].join('\n');
}
