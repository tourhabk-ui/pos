'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { plural } from '@/lib/home/data-freshness';

interface Fact {
  num: string;
  text: string;
  href?: string;
}

interface EditorialSectionProps {
  /** Живые цифры из единого источника (lib/stats/platform-counts). null — БД недоступна. */
  mchsRoutes: number | null;
  safetyProfiles: number | null;
}

export function EditorialSection({ mchsRoutes, safetyProfiles }: EditorialSectionProps) {
  // Вневременной факт остаётся статикой; цифры платформы — из БД, не хардкод
  // (раньше 154/763 жили здесь и расходились со StatsBand).
  //
  // Аудит 24.09 (#126): факт о гибели стоял ПЕРВЫМ и цветом --danger, а
  // --danger по токенам (§2) закреплён за SOS и ошибками: красная цифра рядом
  // с продажей читалась как тревога сейчас. Факт остаётся — это правда о
  // горах, — но цветом текста и последним.
  const FACTS: Fact[] = [
    ...(mchsRoutes != null ? [{ num: mchsRoutes.toLocaleString('ru-RU'), text: `${plural(mchsRoutes, 'маршрут требует', 'маршрута требуют', 'маршрутов требуют')} регистрации в МЧС`, href: '/routes?kind=route' }] : []),
    ...(safetyProfiles != null ? [{ num: safetyProfiles.toLocaleString('ru-RU'), text: `${plural(safetyProfiles, 'точка', 'точки', 'точек')} с профилем безопасности`, href: '/places' }] : []),
    { num: '6', text: 'туристов погибло на Ключевском — 2022', href: '/safety/incidents' },
  ];

  return (
    <section className="py-24 md:py-32 bg-[var(--bg-card)] overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-16 items-center">
          {/* Text Content */}
          <div className="lg:col-span-7 order-2 lg:order-1">
            <div className="w-12 h-1 bg-[var(--accent)] mb-10" />
            <h2 className="font-playfair text-5xl md:text-7xl font-bold mb-10 leading-[1.1] text-[var(--text-primary)] text-balance">
              Штурман, а не <br /> 
              <span className="italic text-[var(--accent)]">тур-агент</span>
            </h2>
            
            <div className="space-y-8 text-lg md:text-xl text-[var(--text-secondary)] font-light leading-relaxed max-w-2xl">
              <p>
                Ведар — это не очередной каталог отелей. Это ваш цифровой проводник, созданный теми, кто знает каждый распадок и каждую фумаролу Мутновского вулкана.
              </p>
              <p>
                Мы верим в честный туризм. Наша задача — дать вам объективные данные: от реальной сложности маршрута до актуальной активности медведей на Курильском озере.
              </p>
            </div>

            <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-10 border-t border-[var(--border)] pt-12">
              {FACTS.map((f, i) => (
                <div key={i}>
                  <p className="text-4xl font-playfair font-bold mb-2 text-[var(--text-primary)] lining-nums tabular-nums">
                    {f.num}
                  </p>
                  <p className="text-xs uppercase tracking-widest text-[var(--text-secondary)] font-bold leading-relaxed">
                    {f.text}
                  </p>
                  {f.href && (
                    <Link href={f.href} className="text-xs text-[var(--accent)] font-bold uppercase tracking-widest mt-2 inline-block hover:underline">
                      Подробнее →
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Visual Content */}
          <div className="lg:col-span-5 order-1 lg:order-2 relative hidden md:block">
            <div className="relative z-10 rounded-lg overflow-hidden shadow-2xl bg-[var(--bg-primary)] aspect-[4/5]">
              <Image 
                src="/images/hero/IMG_20260316_133026.jpg" 
                alt="Ключевская сопка" 
                fill
                className="object-cover opacity-80"
              />
              <div className="absolute inset-0 ring-1 ring-[var(--border)] ring-inset" />
              <div className="absolute bottom-6 left-6 right-6 p-4 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
                {/* Подпись к кадру, а не к тексту рядом (#121): этот же снимок —
                    правильный конус с линзовидным облаком — в «Историях» подписан
                    «Ключевской». Мутновский — плоский массив с кратерами, конусом
                    он не выглядит; две подписи одного кадра не могут быть обе верны. */}
                <p className="text-[var(--text-primary)] text-xs font-bold uppercase tracking-widest mb-1">Локация</p>
                <p className="text-[var(--text-primary)] font-playfair italic text-lg">Ключевская сопка</p>
              </div>
            </div>
            
            {/* Decorative Elements */}
            <div className="absolute -top-10 -right-10 w-64 h-64 bg-[var(--accent)]/10 blur-3xl -z-10 rounded-full" />
            <div className="absolute -bottom-10 -left-10 w-48 h-48 bg-[var(--ocean)]/10 blur-3xl -z-10 rounded-full" />
          </div>
        </div>
      </div>
    </section>
  );
}
