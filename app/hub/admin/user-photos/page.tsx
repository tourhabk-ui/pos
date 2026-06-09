import type { Metadata } from 'next';
import { UserPhotosClient } from './_UserPhotosClient';

export const metadata: Metadata = {
  title: 'Фото туристов — Admin',
};

export default function UserPhotosPage() {
  return <UserPhotosClient />;
}
