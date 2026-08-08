/**
 * Маяк воронки (Эволюция 3.0, п.5). Шлёт ВЗАИМОДЕЙСТВИЕ в POST /api/funnel и
 * НИКОГДА не мешает странице: любая ошибка глотается, ответ не ждётся.
 * sendBeacon переживает уход со страницы; fallback — fetch с keepalive.
 *
 * Единственный шаг — booking_start (первое касание формы брони, entityId =
 * id тура). Просмотры страниц маяком НЕ шлём: их уже пишет собственная
 * метрика (PageViewTracker → page_views), объектив scanFunnel читает её —
 * владелец 08.08: «у нас была настроена своя метрика».
 */

export type FunnelStep = 'booking_start';

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
