import type { Metadata } from 'next';
import SelectionClient from './_SelectionClient';

interface Props { params: Promise<{ code: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  return {
    title: 'Подборка туров | Ведар',
    description: 'Персональная подборка туров на Камчатку.',
    robots: { index: false, follow: false },
    alternates: { canonical: `/p/${code}` },
  };
}

export default async function SelectionPage({ params }: Props) {
  const { code } = await params;
  return <SelectionClient code={code} />;
}
