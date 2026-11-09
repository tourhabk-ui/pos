/**
 * Что под закрытым `/api/` открыто обходу (аудит 09.11).
 *
 * `Disallow: /api/` стоит у всех групп robots.txt, и правильно: кабинеты,
 * кроны и записи там. Но с тем же префиксом живут две вещи, которые должны
 * быть видны снаружи:
 *
 *  - фотографии страниц: og:image у 160 страниц (72 места, 72 тура),
 *    картинки JSON-LD и `<img>` отдаются с `/api/images/` и `/api/photos/`.
 *    Под общим запретом поисковик не мог взять ни превью, ни снимок в поиск
 *    по картинкам;
 *  - читающие эндпоинты, которые `openapi.json` (и через него llms.txt)
 *    предлагает агентам: туры, маршруты, места, безопасность, погода. Агент,
 *    уважающий robots.txt, отказался бы их вызвать — как раньше MCP.
 *
 * Список эндпоинтов выводится из самой спецификации: GET-путь до первого
 * параметра. Новый эндпоинт в спецификации не может остаться закрытым, а
 * закрытый не попадёт в robots.txt без спецификации.
 */
import { buildOpenApiDocument } from '@/lib/api/openapi';

export const MEDIA_ENTRYPOINTS = ['/api/images/', '/api/photos/'] as const;

/** GET-пути спецификации под `/api/` — префиксом до первого параметра. */
export function openApiReadPrefixes(): string[] {
  const doc = buildOpenApiDocument('https://vedarai.ru') as { paths?: Record<string, Record<string, unknown>> };
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    if (!path.startsWith('/api/') || !ops || typeof ops !== 'object' || !('get' in ops)) continue;
    const brace = path.indexOf('{');
    out.add(brace === -1 ? path : path.slice(0, brace));
  }
  return [...out].sort();
}

/** Всё, что robots.txt открывает под `/api/` сверх входов агентов. */
export function publicApiAllow(): string[] {
  return [...MEDIA_ENTRYPOINTS, ...openApiReadPrefixes()];
}
