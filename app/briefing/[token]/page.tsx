import type { Metadata } from 'next';
import BriefingClient from './_BriefingClient';

export const metadata: Metadata = {
  title: 'Брифинг похода — Ведар',
  description: 'План выхода и время возврата: что делать, если человек не вернулся вовремя.',
  robots: 'noindex',
};

interface Props {
  params: Promise<{ token: string }>;
}

export default async function BriefingPage({ params }: Props) {
  const { token } = await params;
  return <BriefingClient token={token} />;
}
