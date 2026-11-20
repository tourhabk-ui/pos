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
import { JsonLd, BreadcrumbJsonLd } from '@/components/seo/JsonLd';
import { chronicleForPark, type ChronicleHero } from '@/lib/chronicle/articles';
import { photoPath } from '@/lib/images/photo-key';
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

/**
 * Объект ЮНЕСКО «Вулканы Камчатки» — факт с источником для вводного абзаца
 * (Сыщик 21.11: хабу нужен ответ сразу, только факты со ссылкой).
 */
const UNESCO_URL = 'https://whc.unesco.org/en/list/765';

/** Снимок для карточки — только из летописи Ведара и только с лицензией. */
function licensedHero(slug: string): ChronicleHero | null {
  for (const a of chronicleForPark(slug)) {
    if (a.hero && a.hero.license) return a.hero;
  }
  return null;
}

/** «охраняемая территория / охраняемые территории / охраняемых территорий». */
function territoryWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'охраняемая территория';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'охраняемые территории';
  return 'охраняемых территорий';
}

/** «1 заповедник, 2 национальных парка…» — счёт по роду из имени записи. */
function kindCounts(parks: ParkListItem[]): string {
  const forms: Record<string, [string, string, string]> = {
    'Заповедник': ['заповедник', 'заповедника', 'заповедников'],
    'Национальный парк': ['национальный парк', 'национальных парка', 'национальных парков'],
    'Природный парк': ['природный парк', 'природных парка', 'природных парков'],
    'Заказник': ['заказник', 'заказника', 'заказников'],
    'Памятник природы': ['памятник природы', 'памятника природы', 'памятников природы'],
  };
  const plural = (n: number, f: [string, string, string]) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? f[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? f[1] : f[2];
  };
  const counts = new Map<string, number>();
  for (const p of parks) { const k = parkKindLabel(p.displayName); counts.set(k, (counts.get(k) ?? 0) + 1); }
  return Object.keys(forms).filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${plural(counts.get(k)!, forms[k])}`).join(', ');
}

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
        numberOfItems: parks.length,
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
      {itemList && <BreadcrumbJsonLd items={[
        { name: 'Главная', url: BASE },
        { name: TITLE, url: `${BASE}/park` },
      ]} />}
      <Header />
      <main className="ds-page px-4 pt-20 pb-16">
        <div className="mb-10">
          <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">
            Охраняемые территории
          </p>
          <h1 className="ds-h1 mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            {TITLE}
          </h1>
          {/* Ответ сразу (Сыщик 21.11): число и род территорий — из справочника,
              ЮНЕСКО — со ссылкой на страницу объекта. Ничего от себя. */}
          <div className="text-[var(--text-secondary)] max-w-2xl space-y-2" data-park-intro="">
            {parks && parks.length > 0 && (
              <p>В справочнике Ведара {parks.length} {territoryWord(parks.length)} Камчатки: {kindCounts(parks)}.</p>
            )}
            <p>
              Объект Всемирного наследия ЮНЕСКО «Вулканы Камчатки» состоит из шести участков; он внесён в список в 1996 году, границы расширены в 2001-м (
              <a href={UNESCO_URL} className="underline hover:text-[var(--accent)]" rel="noopener" target="_blank">UNESCO, Volcanoes of Kamchatka</a>).
            </p>
            <p>
              На странице каждой территории — её маршруты, условия посещения (разрешение, если оно нужно) и регистрация в МЧС перед выходом.
            </p>
          </div>
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
              const hero = licensedHero(p.slug);
              return (
                <li key={p.slug}>
                  <Link
                    href={`/park/${p.slug}`}
                    className="ds-card group flex items-start gap-4 hover:shadow-md transition-all duration-200"
                  >
                    {hero ? (
                      // Снимок из летописи Ведара с лицензией; подпись — ниже текста.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photoPath(hero.key)}
                        alt={hero.alt}
                        width={96}
                        height={72}
                        loading="lazy"
                        decoding="async"
                        className="w-24 h-18 rounded-lg object-cover flex-shrink-0"
                        style={{ height: 72 }}
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 bg-[var(--bg-hover)]">
                        <Trees className="w-6 h-6 text-[var(--accent)]" aria-hidden="true" />
                      </div>
                    )}
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
                      {hero && (
                        <p className="text-[11px] text-[var(--text-muted)] mt-1" data-photo-credit="">
                          Фото: {hero.author}, {hero.license}
                        </p>
                      )}
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
