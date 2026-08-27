'use client';

/**
 * Главная цифра поля: сколько до следующей точки (макеты FCN).
 *
 * Она крупная не ради красоты. Её читают на ходу, в перчатке, боковым
 * зрением, иногда одним глазом из-под капюшона — поэтому число набрано
 * так, что различимо без фокусировки, а всё остальное вокруг мельче на
 * порядок.
 *
 * Мёртвый фикс не стирает цифру — это последнее, что человек знает о своём
 * положении, — но и не выдаёт её за текущую: цвет уходит в приглушённый.
 */

import { Binoculars, Clock, Mountain } from 'lucide-react';

export interface FieldDistanceProps {
  /** Готовая подпись расстояния («1,8 км»); null — считать нечего. */
  distanceLabel: string | null;
  live: boolean;
  /** Подпись под числом. */
  caption: string;
  /** Имя следующей точки — если добавляет знание. */
  pointName: string | null;
  /** Оценка времени в пути («~32 мин»); null — темпа ещё нет. */
  etaLabel: string | null;
  /** Набор высоты впереди («+110 м»); null — высот в данных нет. */
  ascentLabel: string | null;
}

export function FieldDistance(p: FieldDistanceProps) {
  if (p.distanceLabel === null) return null;

  // «1,8 км» → число и единица набираются разным кеглем.
  const m = p.distanceLabel.match(/^([\d.,]+)\s*(.*)$/);
  const value = m ? m[1] : p.distanceLabel;
  const unit = m ? m[2] : '';

  return (
    <div className="w-full text-center">
      <div className="flex items-end justify-center gap-1.5">
        <span className="font-bold leading-none tabular-nums"
          style={{
            fontSize: 'clamp(56px, 22vw, 92px)',
            letterSpacing: '-2px',
            color: p.live ? 'var(--text-primary)' : 'var(--text-muted)',
          }}>
          {value}
        </span>
        {unit && (
          <span className="font-bold pb-2"
            style={{ fontSize: 'clamp(18px, 6vw, 26px)', color: p.live ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            {unit}
          </span>
        )}
      </div>
      <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{p.caption}</p>

      {/* Чипы контекста: куда, сколько идти, сколько набирать. Показываем
          только то, что есть в данных — пустой чип хуже отсутствующего. */}
      {(p.pointName || p.etaLabel || p.ascentLabel) && (
        <div className="flex items-center justify-center flex-wrap gap-x-3 gap-y-1 mt-2.5 text-sm">
          {p.pointName && (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ocean)' }}>
              <Binoculars className="w-4 h-4 shrink-0" />
              {p.pointName}
            </span>
          )}
          {p.etaLabel && (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ocean)' }}>
              <Clock className="w-4 h-4 shrink-0" />
              {p.etaLabel}
            </span>
          )}
          {p.ascentLabel && (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ocean)' }}>
              <Mountain className="w-4 h-4 shrink-0" />
              {p.ascentLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
