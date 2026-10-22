'use client';

/**
 * Что карта планировщика говорит словами (22.10).
 *
 * Владелец со скрином /planner на телефоне: «как работает карта в
 * Планировщике не пойму?». На карте не было ни слова о том, что такое точки
 * и что будет по нажатию; плашка обещала четыре цвета зон, которых карта не
 * рисовала; отказ загрузки выглядел как «маршрутов нет». Здесь — одна
 * колонка в левом верхнем углу:
 *
 *   • при замене дня — плашка замены (что нажать и что значат яркие и
 *     серые точки);
 *   • загрузка / отказ / «маршрутов нет» — три разных состояния, разными
 *     словами (§4.0: отказ — не «нет данных»);
 *   • легенда — только зоны, которые нарисованы, тем же цветом, что пин
 *     (lib/planner/map-markers, plannerLegend);
 *   • подсказка, что делать с точкой, и что значат кружки с номером.
 *
 * Стекло тёмное (поверх карты, §2): `data-theme="dark"`, текст —
 * `--glass-fg`. Отказ узнаётся кромкой цвета предупреждения, кнопка
 * «Повторить» — сплошная.
 */

import { useId, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Loader, RotateCw, X } from 'lucide-react';
import type { LegendEntry } from '@/lib/planner/map-markers';
import { planDayHex } from '@/lib/planner/zone-style';

export type PlannerMapStatus = 'loading' | 'ok' | 'empty' | 'failed';

export const MAP_TEXT = {
  loading: 'Загружаем маршруты по вашим интересам…',
  failed: 'Маршруты не загрузились. Проверьте связь и обновите страницу.',
  retry: 'Повторить',
  empty: 'Под выбранные интересы маршрутов с координатами нет.',
  partial: 'Часть маршрутов не загрузилась.',
  legendTitle: 'Маршруты по зонам',
  days: 'Дни вашего плана. Нажмите кружок — день откроется для замены.',
  hintNoPlan: 'Точки — маршруты под ваши интересы. Нажмите точку — откроется карточка маршрута.',
  hintPlan: 'Точки — маршруты под ваши интересы. Нажмите точку, чтобы добавить её днём или заменить день.',
  editAction: 'Нажмите точку на карте — она встанет вместо этого дня.',
  editColors: 'Яркие — та же зона, что у дня, серые — другие.',
} as const;

const GLASS = 'fx-glass-dense rounded-2xl px-3 py-2.5 shadow-lg text-[var(--glass-fg)]';

/** Кружок с номером — как пин дня на карте. */
function DaySwatch({ n, size = 'sm' }: { n: number; size?: 'sm' | 'md' }) {
  const box = size === 'md' ? 'w-7 h-7 text-[11px]' : 'w-4 h-4 text-[9px]';
  return (
    <span
      aria-hidden
      className={`${box} shrink-0 rounded-full ring-2 ring-white/90 flex items-center justify-center font-bold text-[var(--text-primary)]`}
      style={{ background: planDayHex() }}
    >
      {n}
    </span>
  );
}

export function PlannerMapOverlay({
  status, refreshing = false, legend, total, partial, hasPlan, editing, onRetry, onStopEditing,
}: {
  status: PlannerMapStatus;
  /** Идёт перезагрузка, а на карте ещё прежние точки. */
  refreshing?: boolean;
  legend: readonly LegendEntry[];
  total: number;
  /** Часть интересов не загрузилась, но точки есть. */
  partial: boolean;
  hasPlan: boolean;
  editing: { number: number; title: string } | null;
  onRetry: () => void;
  onStopEditing: () => void;
}) {
  // Свернуть можно: на телефоне развёрнутая легенда закрывает север края.
  // По умолчанию развёрнута — человек сначала должен прочитать, что на карте.
  const [collapsed, setCollapsed] = useState(false);
  const detailsId = useId();
  const showLegend = status === 'ok' && !editing;
  const showDays = hasPlan && !editing;
  const open = !showLegend || !collapsed;
  // При замене дня «нажмите точку» — только когда точки есть. Нет точек —
  // плашка замены говорит, почему, вместо второй плашки поверх карты.
  const editingInline = editing && (status === 'loading' || status === 'empty');

  return (
    <div
      data-theme="dark"
      className="absolute top-3 left-3 right-14 lg:right-auto lg:max-w-sm z-10 flex flex-col gap-2 pointer-events-none"
    >
      {editing && (
        <div
          className={`${GLASS} pointer-events-auto flex items-center gap-3`}
          style={{ border: '1px solid color-mix(in srgb, var(--accent) 70%, transparent)' }}
        >
          <DaySwatch n={editing.number} size="md" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold truncate">Замена дня {editing.number}: {editing.title}</p>
            {status === 'ok' && (
              <>
                <p className="text-[11px] leading-snug text-[var(--glass-fg-muted)]">{MAP_TEXT.editAction}</p>
                <p className="text-[11px] leading-snug text-[var(--glass-fg-muted)]">{MAP_TEXT.editColors}</p>
              </>
            )}
            {editingInline && (
              <p role="status" className="text-[11px] leading-snug text-[var(--glass-fg-muted)]">
                {status === 'loading' ? MAP_TEXT.loading : MAP_TEXT.empty}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onStopEditing}
            aria-label="Закончить замену дня"
            className="w-9 h-9 -mr-1 flex items-center justify-center rounded-lg text-[var(--glass-fg-muted)] hover:text-[var(--glass-fg)] transition-colors duration-200 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {status === 'loading' && !editingInline && (
        <div role="status" className={`${GLASS} flex items-center gap-2 text-xs`}>
          <Loader className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden />
          {MAP_TEXT.loading}
        </div>
      )}

      {status === 'failed' && (
        <div
          role="alert"
          className={`${GLASS} pointer-events-auto flex items-start gap-2`}
          style={{ border: '1px solid color-mix(in srgb, var(--warning) 60%, transparent)' }}
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden />
          <div className="flex-1 min-w-0">
            <p className="text-xs leading-snug">{MAP_TEXT.failed}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-[var(--warning)] text-[var(--bg-primary)] transition-opacity duration-200 hover:opacity-90"
            >
              <RotateCw className="w-3.5 h-3.5" aria-hidden />
              {MAP_TEXT.retry}
            </button>
          </div>
        </div>
      )}

      {status === 'empty' && !editingInline && (
        <div role="status" className={`${GLASS} text-xs leading-snug`}>
          {MAP_TEXT.empty}
        </div>
      )}

      {(showLegend || showDays) && (
        <div className={GLASS} aria-live="polite">
          {showLegend && (
            <button
              type="button"
              onClick={() => setCollapsed(c => !c)}
              aria-expanded={!collapsed}
              aria-controls={detailsId}
              className="pointer-events-auto w-full flex items-center gap-1.5 text-xs font-semibold text-left -my-1 py-1"
            >
              <span className="flex-1">{MAP_TEXT.legendTitle} · {total}</span>
              {refreshing && <Loader className="w-3 h-3 animate-spin" aria-label="Обновляем" />}
              {collapsed
                ? <ChevronDown className="w-4 h-4 shrink-0 text-[var(--glass-fg-muted)]" aria-hidden />
                : <ChevronUp className="w-4 h-4 shrink-0 text-[var(--glass-fg-muted)]" aria-hidden />}
              <span className="sr-only">{collapsed ? 'Показать легенду' : 'Свернуть легенду'}</span>
            </button>
          )}
          {open && (
            <div id={detailsId}>
              {showLegend && (
                <ul aria-label="Цвета зон на карте" className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                  {legend.map(e => (
                    <li key={e.zone ?? 'none'} className="flex items-center gap-1.5 text-xs">
                      <span
                        aria-hidden
                        className="w-2.5 h-2.5 shrink-0 rounded-full ring-1 ring-white/80"
                        style={{ background: e.hex }}
                      />
                      <span>{e.name}</span>
                      <span className="text-[var(--glass-fg-muted)]">{e.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              {showLegend && partial && (
                <p className="mt-1.5 text-[11px] leading-snug text-[var(--warning)]">{MAP_TEXT.partial}</p>
              )}
              {showDays && (
                <p className={`flex items-center gap-1.5 text-xs ${showLegend ? 'mt-1.5' : ''}`}>
                  <DaySwatch n={1} />
                  {MAP_TEXT.days}
                </p>
              )}
              {showLegend && (
                <p className="mt-1.5 text-[11px] leading-snug text-[var(--glass-fg-muted)]">
                  {hasPlan ? MAP_TEXT.hintPlan : MAP_TEXT.hintNoPlan}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
