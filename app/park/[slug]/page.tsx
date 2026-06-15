import type { Metadata } from 'next';
import ParkClient from './_ParkClient';

const PARK_NAMES: Record<string, string> = {
  nalychevo:    'Природный парк «Налычево»',
  bystrinskiy:  'Природный парк «Быстринский»',
  klyuchevskoy: 'Природный парк «Ключевской»',
  komandorskiy: 'Командорский заповедник',
};

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const name = PARK_NAMES[slug] ?? 'Природный парк Камчатки';
  return {
    title: `${name} — маршруты, карты офлайн, регистрация МЧС | Ведар`,
    description: `Маршруты, офлайн-карты и регистрация в МЧС для ${name}. Скачайте карту до выхода в поле.`,
    alternates: { canonical: `/park/${slug}` },
  };
}

export default async function ParkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ParkClient slug={slug} />;
}
