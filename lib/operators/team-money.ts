/**
 * Деньги на общих экранах кабинета оператора для менеджера команды
 * (CRM фаза 2г). Решение владельца 11.10: менеджеру доступно всё, кроме
 * денег и настроек. Обзор и статистика — общие экраны (брони, туры, лиды),
 * поэтому их не закрывают целиком, а вынимают из ответа денежные поля.
 *
 * Вынимают на сервере: скрытое в браузере всё равно приходит в ответе.
 * null, а не 0: ноль читался бы как «выручки нет» (§4.0).
 */
import type { OperatorDashboardData } from '@/types/operator';

export function dashboardWithoutMoney(data: OperatorDashboardData): OperatorDashboardData {
  return {
    ...data,
    moneyHidden: true,
    metrics: {
      ...data.metrics,
      totalRevenue: null,
      monthlyRevenue: null,
      paidRevenue: null,
      paidRevenueMonth: null,
    },
    topTours: data.topTours.map(t => ({ ...t, revenue: null })),
    revenueChart: [],
  };
}

/** Поля тура, которые считаются ценой: их правит владелец или менеджер с правом can_edit_prices. */
export const TOUR_PRICE_FIELDS = ['base_price', 'price_old', 'price_unit'] as const;

/** Трогает ли правка тура цену: поле цены прислано (быстрое заполнение, создание). */
export function touchesTourPrice(input: Record<string, unknown>): boolean {
  return TOUR_PRICE_FIELDS.some(f => input[f] !== undefined);
}

/**
 * Меняет ли правка тура цену. Редактор тура шлёт форму целиком, и цена
 * приходит в каждом сохранении: «прислана» ещё не «изменена». Судить по
 * присланному значило бы, что менеджер без права цен не сохранит даже
 * описание. Сравнение — со строкой тура из базы; числа сравниваются как
 * числа (NUMERIC приходит строкой «12000.00»), пустое — с пустым.
 */
export function changesTourPrice(input: Record<string, unknown>, current: Record<string, unknown>): boolean {
  return TOUR_PRICE_FIELDS.some(f => input[f] !== undefined && !samePriceValue(input[f], current[f]));
}

function samePriceValue(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}
