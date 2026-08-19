/**
 * Маяк воронки (Эволюция 3.0, п.5; шаги — стратегия 14.08). Шлёт
 * ВЗАИМОДЕЙСТВИЕ в POST /api/funnel и НИКОГДА не мешает странице: любая
 * ошибка глотается, ответ не ждётся. sendBeacon переживает уход со страницы;
 * fallback — fetch с keepalive.
 *
 * Имена шагов — из единого словаря lib/funnel/steps.ts (там же их смысл).
 * Просмотры страниц маяком НЕ шлём: их уже пишет собственная метрика
 * (PageViewTracker → page_views), объектив scanFunnel читает её —
 * владелец 08.08: «у нас была настроена своя метрика».
 */

import type { FunnelStep } from '@/lib/funnel/steps';

export type { FunnelStep };

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
