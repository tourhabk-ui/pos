/**
 * Типы сводки суток — без импортов: их берёт клиентская полоса обзора
 * (app/hub/admin/_DaySummary), а серверный lib/analytics/day-summary тянет базу.
 */
/** Исход одного числа: значения за оба дня либо причина, почему их нет. */
export type Metric<T> = { ok: true; today: T; yesterday: T } | { ok: false; error: string };

export interface DaySummary {
  /** Камчатские даты окон, YYYY-MM-DD. «Сегодня» — до текущей минуты. */
  today: string;
  yesterday: string;
  people: Metric<{ visitors: number; views: number; bot_views: number }>;
  mcp: Metric<{ calls: number; callers: number }>;
  a2a: Metric<{ requests: number; callers: number }>;
  kuzmich: Metric<{ answers: number; by_surface: Record<string, number> }>;
}
