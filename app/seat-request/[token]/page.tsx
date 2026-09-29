import type { Metadata } from 'next';
import { SeatRequestStatusClient } from './_SeatRequestStatusClient';

// Страница по личному ключу — в поиск ей нельзя.
export const metadata: Metadata = {
  title: 'Запрос свободных мест',
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SeatRequestStatusClient token={token} />;
}
