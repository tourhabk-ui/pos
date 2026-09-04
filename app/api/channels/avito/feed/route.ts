/**
 * GET /api/channels/avito/feed
 * XML-фид для Авито Автозагрузки
 *
 * Регистрируй этот URL в личном кабинете Авито:
 *   Настройки → Автозагрузка → Добавить фид
 *   URL: https://vedarai.ru/api/channels/avito/feed
 *
 * Авито обновляет фид каждые 2-4 часа автоматически.
 *
 * В ленту уходят ТОЛЬКО готовые туры (lib/tours/readiness). До 04.09 отбор был
 * `is_active AND is_published`, и этого достаточно, чтобы на чужую площадку
 * уехала карточка со стознаковым описанием и без ответа «как я туда попаду» —
 * под именем нашего оператора. Перепись готовности при этом существовала и
 * считала ровно это, но лента про неё не знала: правило жило в кроне, а канал
 * публиковал что попало.
 *
 * Придержанные туры НЕ замалчиваются: их число и причины уходят заголовками
 * X-Withheld-Tours и X-Withheld-Reasons. Иначе пустеющая лента выглядела бы
 * как «у нас мало туров», а не как «туры не готовы, и вот чего им не хватает».
 */

import { generateAvitoXmlFeed } from '@/lib/channels/avito';
import { selectFeedTours, feedHeaders } from '@/lib/channels/ready-tours';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const selection = await selectFeedTours();
    const tours = selection.tours;

    const xml = generateAvitoXmlFeed(tours);

    return new Response(xml, {
      headers: {
        // Сколько придержано и почему — иначе молчание ленты читалось бы как
        // «туров мало», а не как «туры не готовы».
        ...feedHeaders(selection),
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',  // кешируем 1 час
      },
    });
  } catch (e) {
    return new Response(`<?xml version="1.0"?><error>${(e as Error).message}</error>`, {
      status: 500,
      headers: { 'Content-Type': 'application/xml' },
    });
  }
}
