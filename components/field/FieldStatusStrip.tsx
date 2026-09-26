'use client';

/**
 * Верхняя строка кокпита (макеты FCN): «где я и работает ли прибор».
 *
 * Первое, что читает человек, подняв телефон: качество фикса, куда идём,
 * какая точка по счёту. Второй строкой — состояние данных, которое в поле
 * решает не меньше: сохранена ли карта и насколько свежи условия.
 *
 * Тишина — тоже сообщение: когда всё в порядке, строка спокойная и не
 * требует внимания. Плохое состояние окрашивается, а не подсвечивается
 * значком «!» — цвет читается боковым зрением быстрее.
 */

import { Check, MapPin } from 'lucide-react';

export interface FieldStatusStripProps {
  /** Человеческая строка качества фикса: «GPS ±8 м», «Ищем спутники…». */
  fixLabel: string;
  fixLive: boolean;
  routeTitle: string | null;
  /** Счёт контрольных точек; null — точек меньше двух. */
  checkpoint: { current: number; total: number } | null;
  /** Строка состояния данных. null — говорить нечего. */
  dataLine: string | null;
  dataOk: boolean;
  /**
   * Свёрнута ли строка данных (владелец 26.09: «как можно ещё сократить окна,
   * чтоб маршрут работал как у основных навигаторов», шаг 1). Свёрнутая —
   * одна строка прибора, а «карта сохранена · условия N ч назад» —
   * галочкой в конце строки с полной фразой в подсказке; тап раскрывает.
   * Не передан — прежний вид в две строки.
   */
  expanded?: boolean;
  onToggle?: () => void;
}

export function FieldStatusStrip(p: FieldStatusStripProps) {
  const collapsible = p.onToggle !== undefined;
  const showData = p.dataLine && (!collapsible || p.expanded);
  const row = (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs">
      <span className="w-2 h-2 rounded-full shrink-0"
        style={{ background: p.fixLive ? 'var(--success)' : 'var(--warning)' }} />
      <span className="shrink-0 tabular-nums" style={{ color: p.fixLive ? 'var(--success)' : 'var(--warning)' }}>
        {p.fixLabel}
      </span>
      {p.routeTitle && (
        <span className="flex-1 text-center truncate font-semibold px-1"
          style={{ color: 'var(--glass-fg, var(--text-primary))' }}>
          {p.routeTitle}
        </span>
      )}
      {p.checkpoint && (
        <span className="shrink-0 tabular-nums" style={{ color: 'var(--glass-fg-muted, var(--text-secondary))' }}>
          {p.checkpoint.current} из {p.checkpoint.total}
        </span>
      )}
      {collapsible && !p.expanded && p.dataLine && (
        <span className="shrink-0" title={p.dataLine} aria-label={p.dataLine}
          style={{ color: p.dataOk ? 'var(--success)' : 'var(--warning)' }}>
          {p.dataOk ? <Check className="w-3.5 h-3.5" /> : <MapPin className="w-3.5 h-3.5" />}
        </span>
      )}
    </div>
  );
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      {collapsible ? (
        <button type="button" onClick={p.onToggle} aria-expanded={Boolean(p.expanded)}
          title={p.expanded ? 'Свернуть' : 'Состояние карты и данных'}
          className="w-full text-left">
          {row}
        </button>
      ) : row}
      {showData && (
        <div className="flex items-center justify-center gap-1.5 px-4 pb-1.5 text-[11px]"
          style={{ color: p.dataOk ? 'var(--success)' : 'var(--warning)' }}>
          {p.dataOk
            ? <Check className="w-3.5 h-3.5 shrink-0" />
            : <MapPin className="w-3.5 h-3.5 shrink-0" />}
          <span className="truncate">{p.dataLine}</span>
        </div>
      )}
    </div>
  );
}
