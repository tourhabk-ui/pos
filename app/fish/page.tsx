import type { Metadata } from 'next';
import { OfficialSeasonNote } from '@/components/fish/OfficialSeasonNote';
import FishIndexAbout, { FishIndexFirstSection, FishIndexIntro, FishIndexSources } from '@/components/fish/FishIndexAbout';
import { pageContainer } from '@/lib/layout/page-width';
import Link from 'next/link';
import { Fish, Calendar, Trophy } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { FISH_SPECIES } from '@/lib/fish-species';
import { defaultOgImages } from '@/lib/seo/og-image';
import { FishingToursBlock } from '@/components/fish/FishingToursBlock';
import { getFishingTours } from '@/lib/fish/fishing-tours';
import { BreadcrumbJsonLd, JsonLd } from '@/components/seo/JsonLd';
import {
  FISH_PAGE_DESCRIPTION,
  FISH_PAGE_TITLE,
  fishArticleJsonLd,
} from '@/lib/seo/fish-page';

// Рендер на запросе, как у /fish/[id]: туры читаются из базы.
export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  // Под запрос «рыбалка на Камчатке»; виды и сезоны остаются в описании.
  title: FISH_PAGE_TITLE,
  description: FISH_PAGE_DESCRIPTION,
  keywords: [
    'рыбалка на Камчатке', 'рыбы Камчатки', 'лосось Камчатка', 'чавыча', 'нерка', 'кижуч', 'горбуша',
    'путёвка на рыбалку', 'камчатский краб', 'палтус', 'рыболовные туры',
  ],
  alternates: { canonical: 'https://vedarai.ru/fish' },
  openGraph: {
    images: defaultOgImages(),
    title: FISH_PAGE_TITLE,
    description: FISH_PAGE_DESCRIPTION,
    url: 'https://vedarai.ru/fish',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'article',
  },
};

// Метаданные в <head> (seomator 20.11): справочник был целиком синхронным, и
// Next 15.5 отдавал людям и обходчикам вне htmlLimitedBots оболочку страницы
// раньше метаданных — title, canonical и 29 meta уходили в <body>. У страниц с
// запросом в базу (/fish/[id], /faq) метаданные успевают в <head>. Теперь и
// индекс читает туры на рыбалку, как карточка вида, и показывает их блоком.
export default async function FishIndexPage() {
  const tours = await getFishingTours();
  return (
    <>
      <Header />
      <JsonLd data={fishArticleJsonLd(SITE)} />
      {/* Список видов (Сыщик 21.11, §4.2): короткие имена, как на карточках. */}
      <JsonLd data={{
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        '@id': 'https://vedarai.ru/fish#list',
        name: 'Рыбы Камчатки',
        url: 'https://vedarai.ru/fish',
        numberOfItems: FISH_SPECIES.length,
        itemListElement: FISH_SPECIES.map((f, i) => ({ '@type': 'ListItem', position: i + 1, name: f.name, url: `https://vedarai.ru/fish/${f.id}` })),
      }} />
      {/* Хлебные крошки (seomator 20.11: у места, маршрута и тура были, у /fish нет). */}
      <BreadcrumbJsonLd items={[
        { name: 'Главная', url: 'https://vedarai.ru' },
        { name: 'Рыбалка на Камчатке', url: 'https://vedarai.ru/fish' },
      ]} />
      {/* Витрина (lib/layout/page-width, 14.11): до этого у страницы не было ни
          ширины, ни полей — сетка видов шла от края до края окна. */}
      <main className="ds-page pb-16">
        <div className={`${pageContainer('showcase')} pt-6`}>

        <FishIndexIntro />

        <FishIndexFirstSection />

        {/* Сроки в карточках — по ходу рыбы; официальные сроки лова — рядом (Сыщик 21.11). */}
        <div className="mb-6 mt-4"><OfficialSeasonNote /></div>

        {/* Виды — H3 под вопросом о сезоне, чтобы H2 отвечали на запросы туристов. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {FISH_SPECIES.map(species => (
                  <Link
                    key={species.id}
                    href={`/fish/${species.id}`}
                    className="ds-card p-4 group flex items-start gap-4 hover:shadow-md transition-all duration-200 hover:border-[var(--accent)]/30"
                  >
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform duration-200 group-hover:scale-110"
                      style={{ background: `${species.color}18` }}
                    >
                      <Fish className="w-6 h-6" style={{ color: species.color }} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        {species.name}
                      </h3>
                      <p className="text-xs text-[var(--text-muted)] italic mb-2">{species.nameLatin}</p>

                      <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-2">
                        {species.shortDesc}
                      </p>

                      <div className="flex items-center gap-3 mt-3">
                        <span className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                          <Calendar className="w-3 h-3" />
                          {species.season}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                          <Trophy className="w-3 h-3" />
                          {species.recordKg}
                        </span>
                      </div>

                      <div className="flex gap-0.5 mt-2">
                        {Array.from({ length: 12 }, (_, i) => {
                          const active = species.seasonMonths.includes(i + 1);
                          return (
                            <div
                              key={i}
                              className="h-1.5 flex-1 rounded-full"
                              style={{
                                background: active ? species.color : 'var(--bg-hover)',
                                opacity: active ? 1 : 0.4,
                              }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </Link>
                ))}
        </div>

        <FishIndexAbout />

        {/* Туры на рыбалку из базы; не прочитались — прежняя кнопка в каталог. */}
        {tours.length > 0 ? (
          <div className="mt-12">
            <FishingToursBlock tours={tours} />
          </div>
        ) : (
        <div className="mt-12 text-center">
          <Link
            href="/routes?activity_type=fishing"
            className="ds-btn ds-btn-primary px-8 py-3 text-base font-semibold"
          >
            Туры на рыбалку
          </Link>
        </div>
        )}

        <FishIndexSources />
        </div>
      </main>
    </>
  );
}
