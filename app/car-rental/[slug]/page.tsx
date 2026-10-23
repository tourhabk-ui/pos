import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/seo/JsonLd';
import { RentalCompanyPage } from '@/components/rental/RentalCompanyPage';
import { loadRentalPage } from '@/lib/rental/rental-page';
import { loadRentalCompanyBySlug } from '@/lib/rental/rental';
import { minRentalPrice, rentalPagePath } from '@/lib/rental/rental-format';
import { rentalJsonLd } from '@/lib/rental/rental-view';
import { rentalHiddenOnSite } from '@/lib/rental/site-pause';
import { formatRub } from '@/lib/transfers/charter-format';
import { defaultOgImages } from '@/lib/seo/og-image';
import { brandedTitle, fitTitleRequired, RENTAL_TITLE_TAILS } from '@/lib/seo/title-fit';

/**
 * /car-rental/[slug] — страница прокатчика (витрина проката, решение владельца
 * 23.10). Единственная: /operators/<slug> партнёра категории `cars`
 * переадресует сюда.
 *
 * Прайс читается из базы на каждый запрос (цены меняются, а в Docker-сборке
 * базы нет). Прокатчика нет — 404; отказ базы — ошибка страницы, а не
 * «прокатчика нет» (§4.0).
 *
 * Прокатчик под паузой (lib/rental/site-pause, слово владельца 23.10)
 * открывается по прямой ссылке — на неё ведут ответы MCP и A2A, и заявка
 * оставляется только здесь, — но не индексируется и в sitemap не стоит.
 */

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

type Params = { slug: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  // Отказ базы не глушится в «не найден»: метаданные падают так же, как страница.
  const company = SLUG.test(slug) ? await loadRentalCompanyBySlug(slug) : null;
  if (!company) return { title: 'Прокатчик не найден', robots: { index: false, follow: true } };

  const min = minRentalPrice(company);
  const title = fitTitleRequired(company.name, RENTAL_TITLE_TAILS);
  const description = company.shortDescription
    ?? (min !== null ? `Машины без водителя по прайсу: от ${formatRub(min)} за сутки. Заявка — на странице.` : `Прокат автомобилей «${company.name}» на Ведаре.`);
  const url = `${SITE}${rentalPagePath(company.slug)}`;
  const hero = company.photos[0]?.url ?? null;
  return {
    title: brandedTitle(title),
    description,
    alternates: { canonical: url },
    ...(rentalHiddenOnSite(company.slug) ? { robots: { index: false, follow: false } } : {}),
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

export default async function RentalCompanyRoute({ params, searchParams }: {
  params: Promise<Params>;
  /** `?car=` — машина прайса, с которой открыть форму заявки (rentalOrderPath). */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const data = await loadRentalPage(slug);
  if (!data) notFound();
  const query = (await searchParams) ?? {};
  return (
    <>
      <JsonLd data={rentalJsonLd(data.company, SITE)} />
      <RentalCompanyPage data={data} orderCar={query.car} />
    </>
  );
}
