import type { Metadata } from 'next';
import PhotosClient from './_PhotosClient';

export const metadata: Metadata = {
  title: 'Фото объекта | Tourhab',
  description: 'Фотографии объекта размещения',
  robots: 'noindex, nofollow',
};

export default async function StayPhotosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PhotosClient accommodationId={id} />;
}
