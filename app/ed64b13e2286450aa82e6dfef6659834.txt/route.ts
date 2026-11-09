/**
 * GET /<ключ>.txt — файл IndexNow по адресу из спецификации.
 * Содержимое равно имени файла. Тот же ключ отдаёт и /indexnow.txt.
 */

import { INDEXNOW_KEY } from '@/lib/seo/indexnow';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(INDEXNOW_KEY, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
