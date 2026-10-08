import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { groupSummary } from '@/lib/planner/trip-groups';
import { TripGroupClient } from './_TripGroupClient';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Страница группы (#2226): сводка пожеланий и форма своих. Личная и живёт 14
 * дней — в индексе ей не место, ссылку получает тот, кому её дали.
 */
export const metadata: Metadata = {
  title: 'Общий план поездки',
  description: 'Участники отмечают свои пожелания, планер сводит их в один маршрут по Камчатке.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function TripGroupPage({ params }: PageProps) {
  const { id } = await params;
  const read = await groupSummary(id);
  if (read.kind === 'missing') notFound();
  // Отказ базы — не «группы нет»: она лежит на месте (§4.0). Страница ошибки
  // скажет «попробуйте позже», а не отправит собирать группу заново.
  if (read.kind === 'failed') throw new Error('Группа сейчас не прочиталась');
  return <TripGroupClient summary={read.summary} />;
}
