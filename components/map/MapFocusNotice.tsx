'use client';

/**
 * Строка над картой, когда место по ссылке (`/map?place=…`, payload MAX
 * `place-…`) открыть нельзя. Карта при этом открывается обзором края:
 * ссылка не должна молча показывать «что-то другое» (§4.0).
 *
 * Стекло поверх карты, предупреждение — кромкой `--warning` (CLAUDE.md §2),
 * как строка сбоя своей карты в той же колонке.
 */
import type { MapFocus } from '@/lib/map/map-target';

export const MAP_FOCUS_NOT_FOUND =
  'Места по ссылке на карте нет: его скрыли, слили с другим или у него не записана координата. Показываем весь край.';
export const MAP_FOCUS_FAILED =
  'Место по ссылке не загрузилось — показываем весь край. Откройте ссылку ещё раз чуть позже.';

export function MapFocusNotice({ focus }: { focus: MapFocus | null | undefined }) {
  if (!focus || focus.state === 'place') return null;
  return (
    <p role="status" data-theme="dark"
      className="fx-glass-dense max-w-full px-3 py-2 rounded-2xl text-[11px] leading-snug break-words"
      style={{ borderColor: 'var(--warning)', color: 'var(--glass-fg)' }}>
      {focus.state === 'not_found' ? MAP_FOCUS_NOT_FOUND : MAP_FOCUS_FAILED}
    </p>
  );
}
