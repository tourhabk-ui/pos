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

/** Трогает ли правка тура цену. */
export function touchesTourPrice(input: Record<string, unknown>): boolean {
  return TOUR_PRICE_FIELDS.some(f => input[f] !== undefined);
}
