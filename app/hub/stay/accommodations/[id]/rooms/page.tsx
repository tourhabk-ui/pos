import type { Metadata } from 'next';
import RoomsClient from './_RoomsClient';

export const metadata: Metadata = {
  title: 'Номера объекта | Tourhab',
  description: 'Управление номерами объекта размещения',
  robots: 'noindex, nofollow',
};

export default async function StayRoomsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoomsClient accommodationId={id} />;
}
