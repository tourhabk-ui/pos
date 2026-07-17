'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Flame, Snowflake, Waves, Droplets, Bird, ShieldCheck } from 'lucide-react';
import { elementHref } from '@/lib/stats/element-groups';

// href стихий — из единого маппинга (lib/stats/element-groups): десктоп ведёт
// туда же, куда мобайл. Раньше Снег/Океан/Природа вели в category=…, а мобайл
// в location_type=… — одна стихия, разные фильтры.
const ELEMENTS = [
  {
    number: '01',
    title: 'ОГОНЬ',
    subtitle: 'Вулканы и мощь земли',
    icon: Flame,
    href: elementHref('fire'),
    image: '/images/bento/mutnovsky.jpg',
  },
  {
    number: '02',
    title: 'СНЕГ',
    subtitle: 'Хели-ски и ледники',
    icon: Snowflake,
    href: elementHref('snow'),
    image: '/images/hero/hero-dark.jpeg',
  },
  {
    number: '03',
    title: 'ОКЕАН',
    subtitle: 'Чёрные пляжи и серфинг',
    icon: Waves,
    href: elementHref('ocean'),
    image: '/images/bento/khalaktyr.jpg',
  },
  {
    number: '04',
    title: 'ТЕРМЫ',
    subtitle: 'Горячие источники',
    icon: Droplets,
    href: elementHref('therm'),
    image: '/images/bento/laguna.jpg',
  },
  {
    number: '05',
    title: 'ПРИРОДА',
    subtitle: 'Медведи, орлы, нерест',
    icon: Bird,
    href: elementHref('nature'),
    image: '/images/hero/bears-kurilskoye.jpg',
  },
  {
    number: '06',
    title: 'БЕЗОПАСНОСТЬ',
    subtitle: 'Статус вулканов и маршрутов',
    icon: ShieldCheck,
    href: '/safety',
    image: '/images/hero/hero-light.jpeg',
  },
];

export function BentoSection() {
  return (
    <section className="py-20 bg-[var(--bg-primary)]">
      <div className="container mx-auto px-6">
        <div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6">
          <div>
            <span className="text-[var(--accent)] font-bold tracking-[0.4em] uppercase text-[10px] mb-4 inline-block">
              Исследовать по стихии
            </span>
            <h2 className="font-playfair text-4xl md:text-6xl font-bold leading-tight text-[var(--text-primary)]">
              Стихии <br />
              <span className="text-[var(--accent)] italic">Камчатки</span>
            </h2>
          </div>
          <Link
            href="/routes"
            className="text-xs font-bold uppercase tracking-[0.3em] border-b border-[var(--accent)] pb-1 text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors flex-shrink-0"
          >
            Все маршруты
          </Link>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {ELEMENTS.map((el) => {
            const Icon = el.icon;
            return (
              <Link
                key={el.number}
                href={el.href}
                className="group relative h-[280px] md:h-[340px] overflow-hidden rounded-lg bg-[var(--bg-card)] border border-[var(--border)]"
              >
                <div className="absolute inset-0 bg-black/30 group-hover:bg-black/55 transition-colors duration-500 z-10" />
                <Image
                  src={el.image}
                  alt={el.title}
                  fill
                  className="object-cover opacity-70 transition-transform duration-700 group-hover:scale-110"
                  sizes="(max-width: 768px) 50vw, 33vw"
                />

                <div className="relative z-20 p-6 md:p-8 h-full flex flex-col justify-between">
                  <span className="font-playfair italic text-4xl md:text-5xl font-bold leading-none text-white/30 group-hover:text-[var(--accent)]/70 transition-colors duration-500">
                    {el.number}
                  </span>

                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Icon size={16} className="text-white/80 flex-shrink-0" />
                      <h3 className="font-playfair text-lg md:text-2xl text-white font-bold uppercase tracking-wider leading-tight">
                        {el.title}
                      </h3>
                    </div>
                    <p className="text-white/60 text-xs md:text-sm font-light mb-4">
                      {el.subtitle}
                    </p>
                    <div className="w-8 h-px bg-[var(--accent)] transition-all duration-500 group-hover:w-full" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
