import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/seo/JsonLd';
import { CarrierPage } from '@/components/transfers/CarrierPage';
import { loadCarrierPage } from '@/lib/transfers/carrier-page';
import { carrierJsonLd, minCharterPrice } from '@/lib/transfers/carrier-view';
import { carrierPagePath, formatRub } from '@/lib/transfers/charter-format';
import { loadCarrierBySlug } from '@/lib/transfers/charter';
import { defaultOgImages } from '@/lib/seo/og-image';
import { brandedTitle, fitTitleRequired, CARRIER_TITLE_TAILS } from '@/lib/seo/title-fit';

/**
 * /transfers/[slug] — страница перевозчика по стандарту карточки трансфера
 * (решение владельца 13.10; CLAUDE.md §14). Единственная: старый адрес
 * /operators/<slug> перевозчика переадресует сюда.
 *
 * Прайс и поездки читаются из базы на каждый запрос (цены меняются, а в
 * Docker-сборке базы нет). Перевозчика нет — 404; отказ базы — ошибка
 * страницы, а не «перевозчика нет» (§4.0).
 */

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

type Params = { slug: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  // Отказ базы не глушится в «не найден»: метаданные падают так же, как страница.
  const carrier = SLUG.test(slug) ? await loadCarrierBySlug(slug) : null;
  if (!carrier) return { title: 'Перевозчик не найден', robots: { index: false, follow: true } };

  const min = minCharterPrice(carrier);
  const title = fitTitleRequired(carrier.name, CARRIER_TITLE_TAILS);
  const description = carrier.shortDescription
    ?? (min !== null ? `Машина целиком по прайсу: от ${formatRub(min)} за машину. Заявка — на странице.` : `Перевозчик «${carrier.name}» на Ведаре.`);
  const url = `${SITE}${carrierPagePath(carrier.slug)}`;
  const hero = carrier.photos[0]?.url ?? null;
  return {
    title: brandedTitle(title),
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: 'Ведар',
      locale: 'ru_RU',
      type: 'website',
      images: hero ? [{ url: hero }] : defaultOgImages(),
    },
  };
}

export default async function CarrierPageRoute({ params, searchParams }: {
  params: Promise<Params>;
  /** `?to=` — строка прайса, с которой открыть форму заявки (charterOrderPath). */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const data = await loadCarrierPage(slug);
  if (!data) notFound();
  const query = (await searchParams) ?? {};
  return (
    <>
      <JsonLd data={carrierJsonLd(data.carrier, SITE)} />
      <CarrierPage data={data} orderTo={query.to} />
    </>
  );
}
