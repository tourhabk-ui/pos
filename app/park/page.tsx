/**
 * /park — список охраняемых территорий (SEO-аудит 20.11.2026).
 *
 * Карточки `/park/<slug>` были (10 шт., справочник `parks`, миграция 712), а
 * адрес-родитель отвечал 404: обходчик, отрезавший хвост адреса, и человек,
 * стерший его в строке браузера, упирались в «не найдено».
 *
 * Содержимое — только из справочника: имя, род территории по имени
 * (`parkKindLabel`), район по коду (`placeZoneLabel`, кода без подписи нет) и
 * начало описания. Ни площадей, ни «самый…» от себя. База не ответила —
 * так и сказано, а не «парков нет» (§4.0).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { Trees, ChevronRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { listActiveParks, type ParkListItem } from '@/lib/parks/list';
import { parkKindLabel } from '@/lib/parks/park-kind';
import { placeZoneLabel } from '@/lib/places/zone-labels';
import { metaDescription } from '@/lib/seo/meta-description';
import { defaultOgImages } from '@/lib/seo/og-image';

export const dynamic = 'force-dynamic';

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const TITLE = 'Парки, заповедники и заказники Камчатки';
const DESCRIPTION =
  'Заповедник, национальные и природные парки, заказники Камчатки: маршруты, условия посещения и регистрация в МЧС на странице каждой территории.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${BASE}/park` },
  openGraph: {
    images: defaultOgImages(),
    title: TITLE,
    description: DESCRIPTION,
    url: `${BASE}/park`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

/** Длина выдержки из описания в карточке списка. */
const LEAD_MAX = 220;

export default async function ParksIndexPage() {
  let parks: ParkListItem[] | null = null;
  try {
    parks = await listActiveParks();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[park] список парков не прочитан:', `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
  }

  const itemList = parks && parks.length > 0
    ? {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: TITLE,
        itemListElement: parks.map((p, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: p.displayName,
          url: `${BASE}/park/${p.slug}`,
        })),
      }
    : null;

  return (
    <>
      {itemList && <JsonLd data={itemList} />}
      <Header />
      <main className="ds-page px-4 pt-20 pb-16">
        <div className="mb-10">
          <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">
            Охраняемые территории
          </p>
          <h1 className="ds-h1 mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            {TITLE}
          </h1>
          <p className="text-[var(--text-secondary)] max-w-xl">
            На странице каждой территории — её маршруты, условия посещения (разрешение, если оно нужно) и регистрация в МЧС перед выходом.
          </p>
        </div>

        {parks === null ? (
          <p className="text-[var(--text-secondary)]">Не удалось загрузить список. Обновите страницу.</p>
        ) : parks.length === 0 ? (
          <p className="text-[var(--text-secondary)]">В справочнике пока нет ни одной территории.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-4 max-w-3xl">
            {parks.map((p) => {
              const zone = placeZoneLabel(p.zone);
              const lead = metaDescription(p.description, LEAD_MAX);
              return (
                <li key={p.slug}>
                  <Link
                    href={`/park/${p.slug}`}
                    className="ds-card group flex items-start gap-4 hover:shadow-md transition-all duration-200"
                  >
                    <div className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 bg-[var(--bg-hover)]">
                      <Trees className="w-6 h-6 text-[var(--accent)]" aria-hidden="true" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-[var(--text-muted)] mb-1">
                        {parkKindLabel(p.displayName)}{zone ? ` · ${zone}` : ''}
                      </p>
                      <h2
                        className="text-lg font-bold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors"
                        style={{ fontFamily: 'var(--font-playfair)' }}
                      >
                        {p.displayName}
                      </h2>
                      {lead && <p className="text-sm text-[var(--text-secondary)] leading-relaxed mt-1">{lead}</p>}
                    </div>
                    <ChevronRight className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0 mt-1" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}
