/**
 * Человекочитаемый slug из названия (RU→latin). Для ЧПУ-URL маршрутов и мест:
 * `/routes/vulkan-gorely` вместо `/routes/<uuid>` — поисковикам понятнее, чем
 * непрозрачный UUID.
 *
 * Карта транслитерации — та же, что в импортёрах visitkamchatka (проверена на
 * реальных названиях), вынесена сюда как единый источник. Детерминирована:
 * одно и то же название всегда даёт один slug (важно и для бэкфилла в SQL, где
 * логика зеркалится в plpgsql-функции миграции).
 */

const RU_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Максимальная длина slug (совпадает с VARCHAR-лимитом колонки в миграции). */
export const SLUG_MAX_LEN = 80;

/**
 * Строит slug: нижний регистр, транслитерация кириллицы, всё не [a-z0-9] → '-',
 * схлопывание и обрезка дефисов, лимит длины (по границе дефиса, чтобы не рвать
 * слово). Пустой результат (например, из чистых символов) → ''.
 */
export function slugify(input: string): string {
  const translit = input
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => RU_MAP[c] ?? c);

  let s = translit
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (s.length > SLUG_MAX_LEN) {
    s = s.slice(0, SLUG_MAX_LEN).replace(/-+[^-]*$/, '').replace(/-+$/, '');
    // Если единственное «слово» длиннее лимита — жёсткая обрезка.
    if (!s) s = translit.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX_LEN).replace(/-+$/, '');
  }
  return s;
}

/** UUID v1–v5 (для роутинга: отличить `/routes/<uuid>` от `/routes/<slug>`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
