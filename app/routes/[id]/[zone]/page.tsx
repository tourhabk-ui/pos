import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CATEGORY_PAGES } from '@/lib/routes/category-meta';
import { ZONE_PAGES } from '@/lib/routes/zone-meta';
import CategoryPage from '@/components/routes/CategoryPage';

/**
 * Зонный срез категории: /routes/[category]/[zone]
 * (например /routes/vulkani/avachinsky — «Вулканы: Авачинская зона»).
 * Сегмент живёт под [id], поэтому срабатывает ТОЛЬКО когда [id] —
 * категорийный слаг; для UUID маршрута вложенных путей нет — 404.
 * Правило ≥3 применяет CategoryPage (тонкий срез → notFound, вне sitemap).
 */

export const revalidate = 3600;

interface Props {
  params: Promise<{ id: string; zone: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, zone } = await params;
  const catMeta = CATEGORY_PAGES[id];
  const zoneMeta = ZONE_PAGES[zone];
  if (!catMeta || !zoneMeta) return { title: 'Страница не найдена' };

  const title = `${catMeta.name}: ${zoneMeta.name} — маршруты и места`;
  // Описание без обещаний, которые есть не у каждого среза (паспорта, туры):
  // только то, что страница показывает всегда — список с описаниями и координатами
  const description = `${catMeta.name} Камчатки: ${zoneMeta.name} — актуальный список маршрутов и мест с описаниями и координатами.`;
  const url = `https://vedarai.ru/routes/${id}/${zone}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: 'Ведар',
      locale: 'ru_RU',
      type: 'website',
    },
  };
}

export default async function CategoryZonePage({ params }: Props) {
  const { id, zone } = await params;
  const catMeta = CATEGORY_PAGES[id];
  const zoneMeta = ZONE_PAGES[zone];
  if (!catMeta || !zoneMeta) notFound();

  const url = `https://vedarai.ru/routes/${id}/${zone}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${catMeta.name}: ${zoneMeta.name}`,
    url,
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Главная', item: 'https://vedarai.ru' },
        { '@type': 'ListItem', position: 2, name: 'Маршруты', item: 'https://vedarai.ru/routes' },
        { '@type': 'ListItem', position: 3, name: catMeta.name, item: `https://vedarai.ru/routes/${id}` },
        { '@type': 'ListItem', position: 4, name: zoneMeta.name, item: url },
      ],
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <CategoryPage category={id} zone={zone} />
    </>
  );
}
