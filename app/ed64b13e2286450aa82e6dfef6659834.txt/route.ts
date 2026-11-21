/**
 * GET /{key}.txt — стандартное место файла-ключа IndexNow (indexnow.org:
 * «host your key file at the root of your host»). Пинги Ведара указывают
 * keyLocation на /indexnow.txt, и это тоже по стандарту; но поисковик и
 * внешний аудит, не видевшие keyLocation, ищут ключ в корне по его имени —
 * без этого файла там 404 (повторный аудит Сыщика 21.11).
 */

import { INDEXNOW_KEY } from '@/lib/seo/indexnow';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(INDEXNOW_KEY, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
