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
  /**
   * Свёрнутый лист (02.09, карт-бланш владельца): цифра в одну строку с
   * чипами, карта видна на большей части экрана. Кегль меньше, но всё ещё
   * читается на ходу; развёрнутый лист показывает геройский вариант.
   */
  compact?: boolean;
}

export function FieldDistance(p: FieldDistanceProps) {
  if (p.distanceLabel === null) return null;

  // «1,8 км» → число и единица набираются разным кеглем.
  const m = p.distanceLabel.match(/^([\d.,]+)\s*(.*)$/);
  const value = m ? m[1] : p.distanceLabel;
  const unit = m ? m[2] : '';

  if (p.compact) {
    const color = p.live ? 'var(--text-primary)' : 'var(--text-muted)';
    return (
      <div className="w-full flex items-center flex-wrap gap-x-3 gap-y-1">
        <div className="flex items-end gap-1">
          <span className="font-bold leading-none tabular-nums" style={{ fontSize: 34, letterSpacing: '-1px', color }}>
            {value}
          </span>
          {unit && <span className="font-bold pb-0.5" style={{ fontSize: 15, color }}>{unit}</span>}
        </div>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{p.caption}</span>
        {p.etaLabel && (
          <span className="inline-flex items-center gap-1 text-sm" style={{ color: 'var(--ocean)' }}>
            <Clock className="w-3.5 h-3.5 shrink-0" />{p.etaLabel}
          </span>
        )}
        {p.ascentLabel && (
          <span className="inline-flex items-center gap-1 text-sm" style={{ color: 'var(--ocean)' }}>
            <Mountain className="w-3.5 h-3.5 shrink-0" />{p.ascentLabel}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="w-full text-center">
      <div className="flex items-end justify-center gap-1.5">
        <span className="font-bold leading-none tabular-nums"
          style={{
            // 92px на телефоне — четверть высоты листа под одно число
            // (скрин владельца 02.09 08:18). 64 читается на ходу так же,
            // а листу остаётся место под чипы и действия.
            fontSize: 'clamp(44px, 15vw, 64px)',
            letterSpacing: '-1.5px',
            color: p.live ? 'var(--text-primary)' : 'var(--text-muted)',
          }}>
          {value}
        </span>
        {unit && (
          <span className="font-bold pb-1.5"
            style={{ fontSize: 'clamp(16px, 5vw, 22px)', color: p.live ? 'var(--text-primary)' : 'var(--text-muted)' }}>
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
