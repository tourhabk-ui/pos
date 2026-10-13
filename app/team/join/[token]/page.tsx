import { Metadata } from 'next';
import JoinClient from './_JoinClient';

export const metadata: Metadata = {
  title: 'Приглашение в команду оператора',
  description: 'Принять приглашение менеджером в кабинет оператора',
  robots: 'noindex, nofollow',
  // В адресе — одноразовый ключ приглашения: заголовок Referer не должен
  // уносить его на чужие хосты (шрифты, картинки, внешние ссылки).
  referrer: 'no-referrer',
};

export default async function TeamJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinClient token={token} />;
}
