'use client';

/**
 * Коридор «впереди по ходу» (финал полевого экрана, «го» владельца 21.08).
 *
 * Главная цифра говорит про СЛЕДУЮЩУЮ точку; коридор отвечает на вопрос
 * «а что за ней» — до двух точек дальше по маршруту, каждая с длиной
 * своего отрезка. Это честный коридор из наших же route_waypoints:
 * никаких выдуманных бродов и развилок — только то, что есть в данных.
 *
 * Отрезки меряются по прямой между точками, и подпись говорит это прямо
 * (тот же закон, что у линий §12: построение не притворяется путём).
 * Точек впереди нет — блока нет: пустота не заполняется.
 */

import { MapPin, Flag } from 'lucide-react';

export interface CorridorItem {
  name: string;
  /** Длина отрезка до этой точки от предыдущей, км; null — не посчитать. */
  segmentKm: number | null;
  isLast: boolean;
}

export interface FieldCorridorProps {
  items: CorridorItem[];
}

function fmtKm(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(1).replace('.', ',')} км`;
}

export function FieldCorridor({ items }: FieldCorridorProps) {
  if (items.length === 0) return null;

  return (
    <div className="w-full rounded-lg px-3.5 py-2.5"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="text-[10px] tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
        ДАЛЬШЕ ПО МАРШРУТУ
      </div>
      <div className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          <div key={`${it.name}-${i}`} className="flex items-center gap-2.5 text-xs">
            {it.isLast
              ? <Flag className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--success)' }} />
              : <MapPin className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />}
            <span className="flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
              {it.name}
            </span>
            {it.segmentKm !== null && (
              <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                +{fmtKm(it.segmentKm)}
              </span>
            )}
          </div>
        ))}
      </div>
      {/* Отрезки — прямые между точками, не измеренный путь. */}
      <div className="text-[10px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
        отрезки — по прямой между точками
      </div>
    </div>
  );
}
