'use client';

import { plural } from '@/lib/home/data-freshness';
import { HOME_CONTAINER } from '@/lib/home/desktop-layout';

export interface PlatformStats {
  routes: number;
  places: number;
  mchsRoutes: number;
  safetyProfiles: number;
}

interface StatsBandProps {
  /** Живые цифры из БД (null — БД недоступна: показываем только вневременные факты). */
  stats: PlatformStats | null;
}

export function StatsBand({ stats }: StatsBandProps) {
  // Цифры не хардкодим — устаревший хардкод врал (294/778 при реальных ~233/541).
  const items: { num: string; label: string }[] = [
    ...(stats
      ? [
          // Склонение по числу: «61 профиль», не «61 профилей» (#1780).
          { num: stats.routes.toLocaleString('ru-RU'),         label: `${plural(stats.routes, 'маршрут', 'маршрута', 'маршрутов')} в базе` },
          { num: stats.places.toLocaleString('ru-RU'),         label: `${plural(stats.places, 'локация', 'локации', 'локаций')} с координатами` },
          { num: stats.mchsRoutes.toLocaleString('ru-RU'),     label: `${plural(stats.mchsRoutes, 'маршрут', 'маршрута', 'маршрутов')} с регистрацией МЧС` },
          { num: stats.safetyProfiles.toLocaleString('ru-RU'), label: `${plural(stats.safetyProfiles, 'профиль', 'профиля', 'профилей')} безопасности` },
        ]
      : []),
    { num: '24 / 7', label: 'мониторинг угроз' },
  ];

  // Статичная полоса в общей сетке вместо бегущей строки (25.09): бегущая
  // строка шла во всю ширину мимо сетки главной и крутила по кругу слоганы
  // вперемешку с фактами. Цифры — те же, из БД; слоган про открытый сезон
  // снят: это не факт.
  // Ноль не выставляется витриной: «0 маршрутов в базе» читается как
  // пустая платформа, а не как факт (тот же приём, что у LiveOnTrails).
  const shown = items.filter((s) => s.num !== '0');

  return (
    <section className={`${HOME_CONTAINER} pt-6`} aria-label="Платформа в цифрах">
      <dl className="flex flex-wrap gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)]">
        {shown.map((s) => (
          <div key={s.label} className="flex-1 min-w-[180px] bg-[var(--bg-card)] px-5 py-4 flex flex-col-reverse">
            {/* dt раньше dd по разметке списка, цифра визуально сверху. */}
            <dt className="mt-1 text-xs uppercase tracking-[0.12em] text-[var(--text-secondary)] font-medium">
              {s.label}
            </dt>
            <dd
              className="font-playfair font-bold text-[var(--text-primary)] lining-nums tabular-nums"
              style={{ fontSize: 'clamp(1.5rem, 2.2vw, 2rem)' }}
            >
              {s.num}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
