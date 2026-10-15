/**
 * /zh/places/[slug] — китайский конспект места (аудит 15.10, CN-pages; Китай,
 * шаг 7, вариант «в»).
 *
 * Только места по объявленному правилу (lib/zh/content, zhPlaceRuleSql):
 * через место проходит маршрут живого тура. Правило названо на странице.
 * Китайское имя — только из источника (OSM name:zh), иначе русское с
 * пометкой; описание — машинный перевод с пометкой; координаты и высота — из
 * базы; опасности — по-русски из профиля, и только когда профиль не шаблон
 * (lib/safety/profile-source). Цен и туров здесь нет (§9).
 *
 * Индексируется с hreflang ru ↔ zh-CN только с переводом описания, сделанным
 * с нынешнего текста.
 *
 * Сторож: tests/unit/zh-pages.test.tsx.
 */
import type { Metadata } from 'next';
import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { ZhPlaceSummary } from '@/components/zh/ZhDetail';
import { ZH_PLACES_RULE, loadZhPlacePage, logZhFailure, zhPlaceIndexable } from '@/lib/zh/content';
import { decodePathParam, ruPlacePath, zhPlacePath } from '@/lib/zh/pages';
import { readField, ZH_PLACE_FIELDS } from '@/lib/zh/fields';
import { ZH_DETAIL } from '@/lib/zh/detail-text';
import { recordZhEntryHit } from '@/lib/analytics/agent-entry-hits';
import { defaultOgImages } from '@/lib/seo/og-image';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

interface Props {
  params: Promise<{ slug: string }>;
}

const load = cache(async (slug: string) => {
  try {
    return await loadZhPlacePage(slug);
  } catch (err) {
    logZhFailure('страница /zh/places', err);
    throw err;
  }
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const data = await load(slug);
  if (!data) return { title: '未找到地点', robots: { index: false, follow: false } };
  const { place, zhName, translations } = data;
  const desc = readField(ZH_PLACE_FIELDS.description, place.description, translations, 'description');
  const name = zhName?.name ?? `${place.name}${ZH_DETAIL.ruName}`;
  const text = desc.state === 'fresh' ? (desc.zh as string).replace(/\s+/g, ' ').trim() : '';
  const zhDesc = text ? (text.length > 140 ? `${text.slice(0, 139)}…` : text) : '堪察加地点的中文翻译摘要。安全信息以俄文原页为准。';
  const self = `${SITE}${zhPlacePath(place)}`;
  const indexable = zhPlaceIndexable(place, translations);
  const ruCard = `${SITE}${ruPlacePath(place)}`;
  return {
    title: `${name}｜堪察加地点（中文摘要）｜Vedar`,
    description: zhDesc,
    alternates: {
      canonical: self,
      ...(indexable ? { languages: { ru: ruCard, 'zh-CN': self } } : {}),
    },
    openGraph: {
      url: self,
      title: name,
      description: zhDesc,
      images: defaultOgImages(),
      locale: 'zh_CN',
      type: 'website',
      siteName: 'Vedar',
    },
    robots: { index: indexable, follow: true },
  };
}

export default async function ZhPlacePage({ params }: Props) {
  const { slug } = await params;
  recordZhEntryHit(`/zh/places/${slug}`, (await headers()).get('user-agent'));
  const data = await load(slug);
  if (!data) notFound();
  // Пришли по id, а у места есть ЧПУ — 308 на него: один адрес на конспект.
  if (data.place.slug && decodePathParam(slug) !== data.place.slug) permanentRedirect(zhPlacePath(data.place));
  return (
    <>
      <Header />
      <main className="ds-page" lang="zh-CN">
        <ZhPlaceSummary place={data.place} zhName={data.zhName} translations={data.translations} rule={ZH_PLACES_RULE} />
      </main>
    </>
  );
}
