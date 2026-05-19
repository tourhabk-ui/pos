export default function feed(): Record<string, string> {
  const baseUrl = 'https://vedar.app';

  return {
    feed: `${baseUrl}/feed.xml`,
    title: 'Kamchatour Hub — Туры на Камчатку',
    description: 'Обновления туров, активности на Камчатке, новые маршруты.',
    language: 'ru',
  };
}
