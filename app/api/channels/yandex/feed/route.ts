/**
 * GET /api/channels/yandex/feed
 * YML-фид для Яндекс.Услуги и Яндекс.Путешествия
 *
 * Как подключить:
 *   Яндекс.Услуги → бизнес.яндекс.ру → XML-импорт
 *   URL: https://vedarai.ru/api/channels/yandex/feed
 *
 *   Яндекс.Путешествия (партнёрка):
 *   partner.yandex.ru/travel → Тип: экскурсии
 *   URL: https://vedarai.ru/api/channels/yandex/feed
 *
 * Яндекс перечитывает фид раз в 24 часа автоматически.
 *
 * Отбор общий с лентой Авито (lib/channels/ready-tours): уходят только готовые
 * туры, придержанные считаются и называются заголовками. До 04.09 здесь, как и
 * у Авито, стояло `is_active AND is_published` — и ничего больше.
 */

import { generateYandexYmlFeed } from '@/lib/channels/yandex';
import { selectFeedTours, feedHeaders } from '@/lib/channels/ready-tours';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const selection = await selectFeedTours();
    const tours = selection.tours;

    const xml = generateYandexYmlFeed(tours);

    return new Response(xml, {
      headers: {
        ...feedHeaders(selection),
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e) {
    return new Response(
      `<?xml version="1.0"?><error>${(e as Error).message}</error>`,
      { status: 500, headers: { 'Content-Type': 'application/xml' } },
    );
  }
}
