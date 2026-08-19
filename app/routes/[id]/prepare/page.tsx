import type { Metadata } from 'next';
import PrepareClient from './_PrepareClient';

export const metadata: Metadata = {
  title: 'Подготовка к походу — Ведар',
  description: 'План подготовки к выходу: маршрут, условия, навигация, вода, одежда, группа, логистика.',
  robots: 'noindex',
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function PreparePage({ params }: Props) {
  const { id } = await params;
  return <PrepareClient routeId={id} />;
}
