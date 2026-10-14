import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CollectionDetailClient } from './_CollectionDetailClient';
import { defaultOgImages } from '@/lib/seo/og-image';
import { brandedTitle, fitTitle } from '@/lib/seo/title-fit';
import { metaDescription } from '@/lib/seo/meta-description';
import { loadPublicCollections } from '@/lib/collections/list';
import { circularNext } from '@/lib/seo/circular-links';

interface Props { params: Promise<{ slug: string }> }

async function fetchCollection(slug: string) {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
  try {
    const res = await fetch(`${base}/api/collections/${slug}`, { next: { revalidate: 300 } });
    if (!res.ok) {
      // 404 — подборки нет; всё прочее — сбой, и он называется в логе (§4.0).
      if (res.status !== 404) console.error('[collections/page] подборка не прочитана:', slug, `HTTP ${res.status}`);
      return null;
    }
    return (await res.json()).collection;
  } catch (e) {
    console.error('[collections/page] подборка не прочитана:', slug, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Сколько соседних подборок показывать. Перепись 14.10 (прогон 10): на каждую
 * из шести подборок вела одна ссылка — с хаба /collections. Следующие по кругу
 * в порядке хаба дают каждой ровно OTHER_COLLECTIONS входящих
 * (lib/seo/circular-links). Пустые подборки хаб не показывает — и здесь их нет.
 */
const OTHER_COLLECTIONS = 3;

async function otherCollections(slug: string): Promise<Array<{ slug: string; title: string }>> {
  try {
    const all = await loadPublicCollections({ limit: 50 });
    return circularNext(all, (c) => c.slug === slug, OTHER_COLLECTIONS).map((c) => ({ slug: c.slug, title: c.title }));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[collections/page] соседние подборки не прочитаны:', slug, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return [];
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const col = await fetchCollection(slug);
  if (!col) return { title: 'Подборка не найдена' };
  // Хвост «— подборка»: у статей те же имена («Озёра Камчатки», «Вулканы
  // Камчатки»), и две страницы делили один заголовок в выдаче (аудит
  // vedarai.ru 01.10). Описание — по предложению, а не обрывом.
  const title = fitTitle(col.title, [' — подборка']);
  const description = metaDescription(col.description) || `Кураторская подборка «${col.title}»`;
  return {
    title: brandedTitle(title),
    description,
    alternates: { canonical: `/collections/${slug}` },
    openGraph: {
      url: `/collections/${slug}`,
      title,
      description,
      // Нет обложки — картинка по умолчанию, а не []: Next заменяет openGraph
      // страницы целиком, и пустой массив оставлял ссылку без превью.
      images: col.cover_image ? [col.cover_image] : defaultOgImages(),
    },
  };
}

export default async function CollectionDetailPage({ params }: Props) {
  const { slug } = await params;
  const col = await fetchCollection(slug);
  if (!col) notFound();
  return <CollectionDetailClient collection={col} others={await otherCollections(slug)} />;
}
