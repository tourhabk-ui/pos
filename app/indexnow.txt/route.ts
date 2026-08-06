/**
 * GET /indexnow.txt — файл-подтверждение владения хостом для IndexNow.
 *
 * Поисковик, получив пинг, скачивает этот файл и сверяет ключ. Путь намеренно
 * вне /api/: robots.txt закрывает /api/ целиком, а этот файл должен быть
 * доступен краулеру без оговорок.
 */

import { INDEXNOW_KEY } from '@/lib/seo/indexnow';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(INDEXNOW_KEY, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
