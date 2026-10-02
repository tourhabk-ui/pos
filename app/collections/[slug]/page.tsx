import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CollectionDetailClient } from './_CollectionDetailClient';
import { defaultOgImages } from '@/lib/seo/og-image';
import { fitTitle } from '@/lib/seo/title-fit';
import { metaDescription } from '@/lib/seo/meta-description';

interface Props { params: Promise<{ slug: string }> }

async function fetchCollection(slug: string) {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
  try {
    const res = await fetch(`${base}/api/collections/${slug}`, { next: { revalidate: 300 } });
    if (!res.ok) return null;
    return (await res.json()).collection;
  } catch {
    return null;
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
    title,
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
  return <CollectionDetailClient collection={col} />;
}
