/**
 * Правило цены словами — одни и те же у администратора и у владельца тура.
 *
 * Чистый модуль: ни базы, ни `node:*` — его читает клиентский код очереди
 * наценок и экрана «Скидки и наценки».
 */
import { roundedPrice } from '@/lib/tours/pricing-rule-match';

/** То, что нужно знать о правиле, чтобы назвать его словами. */
export interface RuleFacts {
  rule_type: string;
  multiplier: string | number;
  date_from?: string | Date | null;
  date_to?: string | Date | null;
  days_before_min?: number | null;
  days_before_max?: number | null;
  occupancy_min?: number | null;
  guests_min?: number | null;
}

/** Род правила — существительным, для заголовка карточки. */
const RULE_NOUN: Record<string, string> = {
  last_minute: 'Скидка на последние места',
  early_bird: 'Раннее бронирование',
  season_low: 'Низкий сезон',
  season_peak: 'Высокий сезон',
  weekend: 'Выходные (пт–вс)',
  weekend_sat_sun: 'Наценка на выходные (сб, вс)',
  group_discount: 'Скидка группе',
  occupancy_high: 'Дата почти заполнена',
};

/** Незнакомый род видно как записан, а не спрятан. */
export function ruleNoun(ruleType: string): string {
  return RULE_NOUN[ruleType] ?? `правило «${ruleType}»`;
}

function numberOf(v: string | number): number {
  return typeof v === 'number' ? v : parseFloat(v);
}

/**
 * На сколько правило меняет цену: «−15%», «+10%». Множитель 1 или не число —
 * «цену не меняет» / «множитель не прочитан»: это не скидка в ноль процентов.
 */
export function ruleChangeWords(multiplier: string | number): string {
  const m = numberOf(multiplier);
  if (!Number.isFinite(m) || m <= 0) return 'множитель не прочитан';
  const pct = Math.round((m - 1) * 100);
  if (pct === 0) return 'цену не меняет';
  return `${pct < 0 ? '−' : '+'}${Math.abs(pct)}%`;
}

function dayWords(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  const iso = v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : String(v).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return String(v);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/** Когда правило срабатывает — словами; условий нет — `null` («всегда»). */
export function ruleConditionWords(rule: RuleFacts): string | null {
  const parts: string[] = [];
  const from = dayWords(rule.date_from);
  const to = dayWords(rule.date_to);
  if (from && to) parts.push(`с ${from} по ${to}`);
  else if (from) parts.push(`с ${from}`);
  else if (to) parts.push(`по ${to}`);
  const min = rule.days_before_min ?? null;
  const max = rule.days_before_max ?? null;
  if (max !== null && (min === null || min === 0)) parts.push(`когда до выезда ${max} дн. и меньше`);
  else if (max !== null && min !== null) parts.push(`когда до выезда от ${min} до ${max} дн.`);
  else if (min !== null && min > 0) parts.push(`когда до выезда ${min} дн. и больше`);
  if (rule.guests_min !== null && rule.guests_min !== undefined) parts.push(`от ${rule.guests_min} чел.`);
  if (rule.occupancy_min !== null && rule.occupancy_min !== undefined) parts.push(`при заполнении даты от ${rule.occupancy_min}%`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Правило одной строкой: «Скидка на последние места: −15%, когда до выезда 3 дн. и меньше». */
export function ruleWords(rule: RuleFacts): string {
  const when = ruleConditionWords(rule);
  return `${ruleNoun(rule.rule_type)}: ${ruleChangeWords(rule.multiplier)}${when ? `, ${when}` : ''}`;
}

/**
 * Цена за единицу, когда правило сработает, — для строки «10 000 → 8 500».
 * `null` — базовая цена или множитель не прочитаны: пример не выдумывается.
 */
export function ruleExamplePrice(basePrice: unknown, multiplier: string | number): number | null {
  const base = typeof basePrice === 'number' ? basePrice : parseFloat(String(basePrice));
  const m = numberOf(multiplier);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(m) || m <= 0) return null;
  return roundedPrice(base, m);
}

// ─── Карточка очереди администратора ──────────────────────────────────────────

/** Новое правило просится на сайт либо владелец просит снять действующее. */
export type PricingRuleReviewKind = 'new' | 'removal';

export interface PendingPricingRule {
  id: string;
  kind: PricingRuleReviewKind;
  tourId: string;
  tourTitle: string;
  partnerId: string;
  partnerName: string;
  partnerCategory: string | null;
  /** Тур сейчас на сайте: правило изменит цену, которую видят туристы. */
  tourOnSite: boolean;
  /** Правило словами: род, процент, когда срабатывает. */
  words: string;
  /** Действующее правило того же рода, которое новое заменит. Нет — `null`. */
  replaces: string | null;
  /** Цена за единицу, как записал владелец. `null` — не прочитана. */
  basePrice: number | null;
  priceUnit: string | null;
  /** Цена за единицу в день, когда правило срабатывает, — сейчас и после решения. */
  priceNow: number | null;
  priceAfter: number | null;
  /** Отпечаток показанного: решение возвращает его обратно. */
  seen: string;
  since: string;
}
