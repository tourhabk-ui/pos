import type { Metadata } from 'next';
import VoteClient from './_VoteClient';

export const metadata: Metadata = {
  title: 'Голосование группы за дни поездки',
  description: 'Поставьте 👍 или 👎 дням поездки — организатор увидит итог.',
  robots: 'noindex, nofollow',
  referrer: 'no-referrer',
};

interface Props {
  params: Promise<{ token: string }>;
}

export default async function VotePage({ params }: Props) {
  const { token } = await params;
  return <VoteClient token={token} />;
}
