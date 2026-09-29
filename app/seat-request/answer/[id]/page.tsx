import type { Metadata } from 'next';
import { OperatorAnswerClient } from './_OperatorAnswerClient';

export const metadata: Metadata = {
  title: 'Ответ на запрос мест',
  robots: { index: false, follow: false },
};

export default async function Page({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ k?: string }> }) {
  const { id } = await params;
  const { k } = await searchParams;
  return <OperatorAnswerClient id={id} k={k ?? ''} />;
}
