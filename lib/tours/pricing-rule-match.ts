/**
 * lib/tours/pricing-rule-match.ts — КАКИЕ ПРАВИЛА ЦЕНЫ СРАБОТАЛИ.
 *
 * Чистая функция: ни базы, ни сети. Дата, число гостей и занятость приходят
 * аргументами, решение возвращается множителем и списком сработавшего.
 *
 * ── Зачем отдельный модуль (27.09) ────────────────────────────────────────
 *
 * Цикл сопоставления правил был написан ДВАЖДЫ — по пятьдесят строк в
 * `calculateDynamicPrice` и в `bulkDynamicPrices` (`lib/services/tours/
 * dynamic-pricing.ts`), — и уже разошёлся в том, что важнее всего: в
 * источнике занятости.
 *
 *   одиночный расчёт: LEFT JOIN v_tour_daily_occupancy — реальные брони;
 *   bulk:             COALESCE(ta.booked_slots, 0)     — счётчик.
 *
 * Разница не косметическая, и её цену объясняет собственный комментарий
 * одиночного расчёта: счётчик видит только ОПЛАЧЕННЫХ, поэтому пока
 * неоплаченные заявки заполняют дату, `occupancy_high` по счётчику не
 * срабатывает. То есть на один и тот же тур и день два места в платформе
 * отвечали разной ценой, и разную цену получали разные покупатели: bulk зовёт
 * `/api/octo/availability` — чужой канал, одиночный расчёт — наш эндпоинт.
 *
 * Правило, написанное дважды, — это два правила (CLAUDE.md §12). Здесь оно
 * одно, и занятость ему передаёт вызывающий — из одного источника.
 *
 * ── Часовой пояс ──────────────────────────────────────────────────────────
 *
 * Сезон, выходной и «за сколько дней» читаются из даты теми же выражениями,
 * что стояли в обеих копиях (`getMonth`/`getDate`/`getDay`), — намеренно: этот
 * модуль их СВОДИТ, а не меняет поведение. Выражения верны, пока процесс идёт
 * в UTC (строка `YYYY-MM-DD` разбирается как полночь UTC), и это условие
 * выполняется на Timeweb. Переводить их на UTC-геттеры — отдельная правка с
 * отдельной проверкой: она СМЕНИТ цену на границе суток, и делать это заодно
 * со сведением нельзя.
 */

/** Строка `tour_pricing_rules`, как её отдаёт база. */
export interface PricingRule {
  rule_type: string;
  date_from: string | Date | null;
  date_to: string | Date | null;
  days_before_min: number | null;
  days_before_max: number | null;
  occupancy_min: number | null;
  guests_min: number | null;
  multiplier: string | number;
}

export interface RuleContext {
  /** Дата тура, `YYYY-MM-DD`. */
  tourDate: string;
  /** Сколько гостей — для `group_discount`. */
  guests: number;
  /**
   * Занятость слота в процентах — для `occupancy_high`.
   *
   * Считает её ВЫЗЫВАЮЩИЙ и из одного источника: реальных броней
   * (`v_tour_daily_occupancy`), а не из счётчика `booked_slots`. Ноль значит
   * «свободно», и это не то же, что «не знаем»: занятости нет — передавайте
   * 0, и `occupancy_high` не сработает, что и правильно (надбавку за
   * заполненность нельзя брать на догадке).
   */
  occupancyPct: number;
  /** Момент расчёта — для `early_bird` / `last_minute`. Для тестов. */
  now?: Date;
}

export interface RuleMatch {
  /** Произведение множителей всего сработавшего. 1 — цена не меняется. */
  multiplier: number;
  /** Рода сработавших правил, в порядке перебора. */
  appliedRules: string[];
}

/** Дней от «сейчас» до даты тура. Отрицательное — дата уже прошла. */
export function daysBeforeTour(tourDate: string, now: Date = new Date()): number {
  return Math.floor((new Date(tourDate).getTime() - now.getTime()) / 86_400_000);
}

/** Пятница, суббота, воскресенье. */
export function isWeekendDate(tourDate: string): boolean {
  return [5, 6, 0].includes(new Date(tourDate).getDay());
}

function monthDay(d: Date): number {
  return d.getMonth() * 100 + d.getDate();
}

/**
 * Попадает ли дата тура в сезонное окно правила.
 *
 * Год не важен — сезон повторяется; окно, переходящее через год
 * (например 15.12-15.01), поэтому проверяется двумя ветками.
 */
export function inSeasonWindow(rule: PricingRule, tourDate: string): boolean {
  if (!rule.date_from || !rule.date_to) return false;
  const tourMD = monthDay(new Date(tourDate));
  const fromMD = monthDay(new Date(rule.date_from));
  const toMD = monthDay(new Date(rule.date_to));
  return fromMD <= toMD
    ? tourMD >= fromMD && tourMD <= toMD
    : tourMD >= fromMD || tourMD <= toMD;
}

/** Сработало ли ОДНО правило. Незнакомый род — нет, и это не ошибка. */
export function ruleApplies(rule: PricingRule, ctx: RuleContext): boolean {
  switch (rule.rule_type) {
    case 'season_peak':
    case 'season_low':
      return inSeasonWindow(rule, ctx.tourDate);
    case 'early_bird':
    case 'last_minute': {
      const days = daysBeforeTour(ctx.tourDate, ctx.now);
      return (rule.days_before_min === null || days >= rule.days_before_min)
        && (rule.days_before_max === null || days <= rule.days_before_max);
    }
    case 'occupancy_high':
      return rule.occupancy_min !== null && ctx.occupancyPct >= rule.occupancy_min;
    case 'group_discount':
      return rule.guests_min !== null && ctx.guests >= rule.guests_min;
    case 'weekend':
      return isWeekendDate(ctx.tourDate);
    default:
      // Незнакомый род НЕ применяется и цену не меняет. Молча применить его
      // как «ничего» и молча применить как «скидку» — разные вещи; первое
      // безопасно, второе стоило бы денег.
      return false;
  }
}

/** Множитель всего сработавшего и список родов. */
export function matchPricingRules(rules: PricingRule[], ctx: RuleContext): RuleMatch {
  let multiplier = 1;
  const appliedRules: string[] = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, ctx)) continue;
    const m = typeof rule.multiplier === 'number' ? rule.multiplier : parseFloat(rule.multiplier);
    // Испорченный множитель не роняет расчёт и не считается единицей молча:
    // правило пропускается и в список сработавших не попадает.
    if (!Number.isFinite(m) || m <= 0) continue;
    multiplier *= m;
    appliedRules.push(rule.rule_type);
  }
  return { multiplier: Math.round(multiplier * 1000) / 1000, appliedRules };
}

/** Округление цены до 100 ₽ — как было и раньше. */
export function roundedPrice(basePrice: number, multiplier: number): number {
  return Math.round((basePrice * multiplier) / 100) * 100;
}

/**
 * Цена за единицу после правил.
 *
 * Множитель ровно 1 — цена НЕ ТРОГАЕТСЯ, даже округлением. Это не
 * педантизм: округление до сотни применялось безусловно, и тур за 12 950 ₽,
 * у которого есть правило вне своего окна, показывался за 13 000 — цена
 * менялась там, где не сработало ни одно правило. «Скидок нет» обязано
 * означать «цена как записал оператор».
 */
export function finalUnitPrice(basePrice: number, multiplier: number): number {
  return multiplier === 1 ? basePrice : roundedPrice(basePrice, multiplier);
}
