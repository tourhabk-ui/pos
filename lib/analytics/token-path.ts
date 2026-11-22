/**
 * Адреса, где сам путь — ключ доступа. В аналитику (page_views, переходы)
 * такой путь идёт без ключа: `/vote/<токен>` → `/vote`. Иначе любой с
 * доступом к аналитике откроет голосование группы (ревью безопасности #3744).
 * Без node-зависимостей: файл грузится и в браузер (PageViewTracker).
 */
const TOKEN_PATH_PREFIXES = ['/vote'] as const;

export function stripPathToken(path: string): string;
export function stripPathToken(path: string | null | undefined): string | null | undefined;
export function stripPathToken(path: string | null | undefined): string | null | undefined {
  if (!path) return path;
  for (const prefix of TOKEN_PATH_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)) return prefix;
  }
  return path;
}

/** Тот же ключ внутри полного адреса (referrer): `…/vote/<токен>` → `…/vote`. */
export function stripUrlToken(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  return url.replace(/\/vote\/[^?#\s]*/g, '/vote');
}
