'use client';

import React from 'react';
import Image from 'next/image';
import Link from 'next/link';

/**
 * Куда ведут плитки (20.09).
 *
 * Все шесть вели в ОДНУ точку — полный список маршрутов без фильтра. Три
 * несли `location_type` без `kind=place` (витрина умолчанием показывает
 * маршруты и при них отбрасывает тип места), ещё три — `category`, которую
 * страница не читает ВОВСЕ: ни сервер, ни клиент такого параметра не знают.
 *
 * Плитка с подписью «Курильское» обещает озеро с медведями и приводила в
 * общий список. Теперь каждая ведёт туда, что написано на ней: названные
 * места — поиском по имени среди МЕСТ, «Мыс» — по роду места.
 */
const STORIES = [
  { label: 'Ключевской',   image: '/images/hero/IMG_20260316_133026.jpg', href: '/routes?kind=place&location_type=volcano' },
  { label: 'Халактырский', image: '/images/bento/khalaktyr.jpg',           href: '/routes?kind=place&q=%D1%85%D0%B0%D0%BB%D0%B0%D0%BA%D1%82%D1%8B%D1%80' },
  { label: 'Курильское',   image: '/images/hero/bears-kurilskoye.jpg',     href: '/routes?kind=place&q=%D0%BA%D1%83%D1%80%D0%B8%D0%BB%D1%8C%D1%81%D0%BA' },
  { label: 'Паратунка',    image: '/images/bento/paratunka.jpg',           href: '/routes?kind=place&location_type=hot_spring' },
  { label: 'Мутновский',   image: '/images/bento/mutnovsky.jpg',           href: '/routes?kind=place&location_type=volcano' },
  { label: 'Мыс',          image: '/images/bento/cape.jpg',                href: '/routes?kind=place&location_type=cape' },
];

export function StoriesRail() {
  return (
    <div className="px-4 py-5">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-bold text-[var(--text-primary)]">Истории сегодня</span>
        <Link href="/routes" className="text-xs text-[var(--accent)] font-semibold">
          Смотреть все →
        </Link>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
        {STORIES.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="flex-shrink-0 flex flex-col items-center gap-2 group"
          >
            <div className="relative w-[68px] h-[68px] rounded-full overflow-hidden ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-primary)] group-hover:ring-offset-0 transition-all">
              <Image src={s.image} alt={s.label} fill className="object-cover group-hover:scale-110 transition-transform duration-500" />
            </div>
            <span className="text-[10px] font-medium text-[var(--text-secondary)] text-center max-w-[68px] truncate">
              {s.label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
