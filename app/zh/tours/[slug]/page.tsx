/**
 * /zh/tours/[slug] — китайский конспект живого тура (аудит 15.10, CN-pages;
 * Китай, шаг 7, вариант «в»).
 *
 * НЕ вторая карточка тура (CLAUDE.md §11): брони, цены «от» сверх поля базы и
 * своей SOS-кнопки нет; бронь — только на русской карточке, и конспект ведёт
 * на неё. Что откуда — шапка components/zh/ZhDetail.
 *
 * Индексируется и получает пару hreflang ru ↔ zh-CN у каждого живого тура:
 * страница — китайские факты из базы. Проза оператора по-китайски только
 * из свежего перевода и с пометкой; без перевода русский текст на страницу
 * не кладётся (lib/zh/content, zhTourIndexable).
 *
 * Сторож: tests/unit/zh-pages.test.tsx.
 */
import type { Metadata } from 'next';
import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { ZhTourSummary } from '@/components/zh/ZhDetail';
import { loadZhTourPage, logZhFailure, zhTourIndexable } from '@/lib/zh/content';
import { zhTourPath } from '@/lib/zh/pages';
import { readField, ZH_TOUR_FIELDS } from '@/lib/zh/fields';
import { zhFactDescription, zhFactHeading } from '@/lib/zh/entry';
import { tourPath } from '@/lib/tours/tour-url';
import { recordZhEntryHit } from '@/lib/analytics/agent-entry-hits';
import { defaultOgImages } from '@/lib/seo/og-image';
import { loadCnyRate } from '@/lib/currency/cbr-rate';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

interface Props {
  params: Promise<{ slug: string }>;
}

/** Один запрос на метаданные и страницу; отказ базы — в лог и наверх (500, а не «не найдено»). */
const load = cache(async (slug: string) => {
  try {
    return await loadZhTourPage(slug);
  } catch (err) {
    logZhFailure('страница /zh/tours', err);
    throw err;
  }
});

/** Сниппет: свежий перевод краткого описания или описания, иначе общая строка. */
function snippet(text: string | null): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const data = await load(slug);
  if (!data) return { title: { absolute: '未找到团队游｜Vedar 堪察加' }, robots: { index: false, follow: false } };
  const { tour, translations } = data;
  const title = readField(ZH_TOUR_FIELDS.title, tour.title, translations, 'title');
  const short = readField(ZH_TOUR_FIELDS.short_description, tour.short_description, translations, 'short_description');
  const desc = readField(ZH_TOUR_FIELDS.description, tour.description, translations, 'description');
  const zhTitle = title.state === 'fresh' ? (title.zh as string) : zhFactHeading(tour);
  const zhDesc = short.state === 'fresh' ? snippet(short.zh as string)
    : desc.state === 'fresh' ? snippet(desc.zh as string)
      : zhFactDescription(tour);
  const self = `${SITE}${zhTourPath(tour)}`;
  const indexable = zhTourIndexable(tour, translations);
  return {
    // absolute: бренд Vedar уже в строке, а шаблон корневого layout дописал бы
    // русское « | Ведар» к китайскому заголовку (prod-check 137).
    title: { absolute: `${zhTitle}｜堪察加团队游（中文摘要）｜Vedar 堪察加` },
    description: zhDesc,
    alternates: {
      canonical: self,
      // Пара языков — у каждого живого тура; у русской карточки ответная
      // ссылка ставится тем же правилом (zhTourAlternatePath).
      ...(indexable ? { languages: { ru: `${SITE}${tourPath(tour)}`, 'zh-CN': self } } : {}),
    },
    openGraph: {
      url: self,
      title: zhTitle,
      description: zhDesc,
      images: defaultOgImages(),
      locale: 'zh_CN',
      type: 'website',
      siteName: 'Vedar',
    },
    robots: { index: indexable, follow: true },
  };
}

export default async function ZhTourPage({ params }: Props) {
  const { slug } = await params;
  recordZhEntryHit(`/zh/tours/${slug}`, (await headers()).get('user-agent'));
  const [data, cny] = await Promise.all([load(slug), loadCnyRate()]);
  if (!data) notFound();
  // Пришли по числу, а у тура есть адрес — 308 на адрес: один адрес на конспект.
  if (data.byId && data.tour.slug) permanentRedirect(zhTourPath(data.tour));
  return (
    <>
      <Header />
      <main className="ds-page" lang="zh-CN">
        <ZhTourSummary tour={data.tour} translations={data.translations} cny={cny} />
      </main>
    </>
  );
}
