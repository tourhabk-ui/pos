/**
 * lib/services/profanity-filter.ts
 *
 * PurgoMalum — бесплатный фильтр мата/непристойностей без ключа. Отзывы о
 * местах/турах публикуются СРАЗУ при создании (is_verified — просто бейдж,
 * ни один из GET-эндпоинтов отзывов не фильтрует по нему) — поэтому проверка
 * на входе это единственная реальная защита от мгновенной публикации мата,
 * а не просто advisory-флаг для последующей модерации.
 *
 * Сервис доступен только по HTTP (не HTTPS) — ограничение самого PurgoMalum,
 * не наша недоработка. Вызывается только с сервера.
 *
 * Fail-open: недоступность PurgoMalum не блокирует отзыв — возвращает null,
 * вызывающий код должен трактовать null как "не удалось проверить", не как
 * "чисто" и не как "заблокировать".
 */

const PURGOMALUM_BASE = 'http://www.purgomalum.com/service';

export async function containsProfanity(text: string): Promise<boolean | null> {
  const trimmed = text.trim();
  if (!trimmed) return false;

  try {
    const res = await fetch(
      `${PURGOMALUM_BASE}/containsprofanity?text=${encodeURIComponent(trimmed)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return null;

    const body = (await res.text()).trim().toLowerCase();
    if (body !== 'true' && body !== 'false') return null;
    return body === 'true';
  } catch {
    return null;
  }
}
