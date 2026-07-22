import type { Metadata } from 'next';
import WaiverClient from './_WaiverClient';

export const metadata: Metadata = {
  title: 'Согласие с рисками',
  description: 'Подписание согласия с рисками и медицинской декларации для высокорискового тура',
  robots: 'noindex, nofollow',
};

export default async function WaiverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WaiverClient bookingId={id} />;
}
