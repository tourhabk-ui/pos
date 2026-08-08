/**
 * Маяк воронки (Эволюция 3.0, п.5). Одна функция для клиентских компонентов:
 * шлёт шаг воронки в POST /api/funnel и НИКОГДА не мешает странице —
 * любая ошибка глотается, ответ не ждётся. sendBeacon переживает уход
 * со страницы; fallback — fetch с keepalive.
 *
 * Шаги верха воронки (низ — leads/operator_bookings — уже в БД):
 *   catalog_view  — открыт каталог туров
 *   tour_view     — открыта карточка тура (entityId = id тура)
 *   booking_start — первое касание формы брони (entityId = id тура)
 */

export type FunnelStep = 'catalog_view' | 'tour_view' | 'booking_start';

export function funnelBeacon(step: FunnelStep, entityId?: string): void {
  try {
    const body = JSON.stringify({ step, entity_id: entityId ?? null });
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/funnel', new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch('/api/funnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* маяк не должен ломать страницу */ });
  } catch { /* маяк не должен ломать страницу */ }
}
