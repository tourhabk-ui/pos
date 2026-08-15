'use client';

/**
 * Прогресс по маршруту — постоянный второй слой полевого экрана.
 *
 * Компас отвечает «куда сейчас?», этот блок — «сколько сделано и сколько
 * осталось?». Полная ширина, бар 6–8 px, числа всегда рядом с баром: бар
 * без чисел — настроение, а не прибор.
 *
 * Инварианты честности (план FCN, §3.3):
 *  - процент и километраж — только у снятого трека: у наброска линия лжёт
 *    о форме пути, и «пройдено 46%» по ней — та же ложь этажом выше;
 *  - для наброска — счёт точек и километраж с честным словом «по ломаной»;
 *  - мёртвый фикс не двигает и не гасит прогресс: последнее известное
 *    приглушается и подписывается возрастом, а не притворяется живым;
 *  - одна точка — цель, а не ход: блока нет вовсе (totalKm = 0).
 */

import type { TrackFidelity } from '@/lib/routes/track-fidelity';

export interface RouteProgressBarProps {
  doneKm: number;
  totalKm: number;
  percent: number;
  fidelity: TrackFidelity;
  /** Живые ли цифры (свежий пригодный фикс). */
  live: boolean;
  /** Подпись возраста фикса для неживых цифр, например «фикс 4 мин назад». */
  staleLabel: string | null;
  /** Счёт контрольных точек; null — точек меньше двух. */
  checkpoint: { current: number; total: number } | null;
}

export function RouteProgressBar(p: RouteProgressBarProps) {
  if (p.totalKm <= 0) return null;

  const leftKm = Math.max(0, p.totalKm - p.doneKm);

  // Набросок и линия без происхождения: процент по такой линии обещает
  // точность, которой в данных нет. Ход — счётом точек, километраж — с
  // честным словом о ломаной.
  if (p.fidelity !== 'surveyed') {
    return (
      <div className="w-full rounded-xl px-4 py-3"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            {p.checkpoint ? `Точки: ${p.checkpoint.current} из ${p.checkpoint.total}` : 'Маршрут'}
          </p>
          <p className="text-xs" style={{ color: 'var(--warning)' }}>ориентир, не тропа</p>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
          ≈ {p.doneKm.toFixed(1)} из {p.totalKm.toFixed(1)} км по ломаной между точками
        </p>
      </div>
    );
  }

  const barColor = p.live ? 'var(--success)' : 'var(--text-muted)';

  return (
    <div className="w-full rounded-xl px-4 py-3"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-[var(--text-primary)]">Маршрут</p>
        <p className="text-sm font-bold" style={{ color: p.live ? 'var(--success)' : 'var(--text-muted)' }}>
          {p.percent}%
        </p>
      </div>
      <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
        Пройдено {p.doneKm.toFixed(1)} из {p.totalKm.toFixed(1)} км · осталось {leftKm.toFixed(1)} км
      </p>
      {!p.live && p.staleLabel && (
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{p.staleLabel}</p>
      )}
      <div className="h-1.5 rounded-full overflow-hidden w-full mt-2" style={{ background: 'var(--bg-hover)' }}>
        {/* Мёртвый фикс — без анимации: движущийся бар обещает движение. */}
        <div className={`h-full rounded-full ${p.live ? 'transition-all duration-500' : ''}`}
          style={{ width: `${p.percent}%`, background: barColor }} />
      </div>
    </div>
  );
}
