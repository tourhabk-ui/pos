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

    const { xml, skipped } = generateAvitoXmlFeed(tours);

    // Готовый тур, которому не нашлось категории Авито, исчезал молча: он
    // проходил проверку готовности, доезжал до генератора и растворялся, а
    // X-Withheld-Tours считает только неготовность. Замер 06.09: в карте три
    // типа активности, в платформе тринадцать — вулканы, медведи, вертолёт и
    // треккинг в ленту не попадали, и узнать об этом было неоткуда.
    //
    // Считать это «нормой» нельзя: тур, которого нет в ленте, не продаётся.
    // Поэтому число и типы уходят заголовками, а в лог идёт строка — молчание
    // тут дороже шума.
    if (skipped.length > 0) {
      const types = [...new Set(skipped.map((s) => s.activity_type ?? 'нет типа'))];
      console.error(
        `[avito-feed] ${skipped.length} готовых туров без категории Авито: ${types.join(', ')}`
        + ' — типы не заведены в AVITO_CATEGORY_BY_ACTIVITY, объявления по ним не выйдут',
      );
    }

    return new Response(xml, {
      headers: {
        // Сколько придержано и почему — иначе молчание ленты читалось бы как
        // «туров мало», а не как «туры не готовы».
        ...feedHeaders(selection),
        'X-Skipped-No-Category': String(skipped.length),
        'X-Skipped-Types': [...new Set(skipped.map((s) => s.activity_type ?? 'null'))].join(',') || 'none',
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
