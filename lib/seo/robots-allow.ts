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
 * Список эндпоинтов выводится из самой спецификации (openApiReadRules ниже).
 * Новый эндпоинт в спецификации не может остаться закрытым, а эндпоинт вне
 * спецификации не откроется robots.txt.
 */
import { buildOpenApiDocument } from '@/lib/api/openapi';

export const MEDIA_ENTRYPOINTS = ['/api/images/', '/api/photos/'] as const;

/**
 * GET-пути спецификации под `/api/` правилами robots.txt (RFC 9309: `*` —
 * любые символы, `$` — конец адреса, побеждает самое длинное правило).
 *
 * До 10.11 путь открывался префиксом до первого параметра, и под ним
 * открывалось лишнее: `/api/tours` пускал и `/api/tours-feed`, `/api/routes` —
 * построение маршрута (`/api/routes/build`) и разбор (`/api/routes/analysis`),
 * `/api/places/` — генерацию PDF и GPX у каждого места. Это GET, но тяжёлые и
 * не из спецификации: обходчик гонял бы их по каждой ссылке.
 *
 * Теперь открыт ровно путь спецификации:
 *  - путь без параметра — сам адрес (`P$`) и он же с запросом (`P?`):
 *    `/api/tours?region=…` да, `/api/tours-feed` и `/api/routes/build` нет;
 *  - путь с параметром — `{id}` становится `*`, а всё глубже закрыто
 *    (`Disallow: P/`): `/api/places/<id>` да, `/api/places/<id>/pdf` нет.
 *    Более длинный путь спецификации (`/api/tours/*` и `/api/tours/<звезда>/slots`)
 *    перебивает этот запрет по длине.
 */
export function openApiReadRules(): { allow: string[]; disallow: string[] } {
  const doc = buildOpenApiDocument('https://vedarai.ru') as { paths?: Record<string, Record<string, unknown>> };
  const allow = new Set<string>();
  const disallow = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    if (!path.startsWith('/api/') || !ops || typeof ops !== 'object' || !('get' in ops)) continue;
    if (!path.includes('{')) {
      allow.add(`${path}$`);
      allow.add(`${path}?`);
      continue;
    }
    const pattern = path.replace(/\{[^}]+\}/g, '*');
    allow.add(pattern);
    disallow.add(`${pattern}/`);
  }
  return { allow: [...allow].sort(), disallow: [...disallow].sort() };
}

/** Всё, что robots.txt открывает под `/api/` сверх входов агентов. */
export function publicApiAllow(): string[] {
  return [...MEDIA_ENTRYPOINTS, ...openApiReadRules().allow];
}

/** Что под открытыми путями спецификации закрыто: всё глубже параметра. */
export function publicApiDisallow(): string[] {
  return openApiReadRules().disallow;
}
