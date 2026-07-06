'use client';

import React from 'react';
import Image from 'next/image';
import Link from 'next/link';

const STORIES = [
  { label: 'Ключевской',   image: '/images/hero/IMG_20260316_133026.jpg', href: '/routes?location_type=volcano' },
  { label: 'Халактырский', image: '/images/bento/khalaktyr.jpg',           href: '/routes?category=morskie_progulki' },
  { label: 'Курильское',   image: '/images/hero/bears-kurilskoye.jpg',     href: '/routes?category=medvedi' },
  { label: 'Паратунка',    image: '/images/bento/paratunka.jpg',           href: '/routes?location_type=hot_spring' },
  { label: 'Мутновский',   image: '/images/bento/mutnovsky.jpg',           href: '/routes?location_type=volcano' },
  { label: 'Мыс',          image: '/images/bento/cape.jpg',                href: '/routes?category=morskie_progulki' },
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
