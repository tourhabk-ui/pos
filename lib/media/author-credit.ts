/**
 * Подпись автора под снимком — куда она ведёт (владелец 21.11: «по подписи
 * можно было перейти на страницу владельца фото: если это Андрей Запорожец —
 * на его страницу, если турист, например Алина Гусакова, — на её фотоленту,
 * типа маленькой инсты, но с переходом на само место»).
 *
 * Правило одно для всех, без исключений и без ранжирования (CLAUDE.md §0):
 *  - автор — сам партнёр (имя в подписи совпадает с именем партнёра, чей это
 *    снимок) → страница партнёра (`operatorPagePath`); у партнёра без открытой
 *    страницы имя остаётся текстом;
 *  - автор — человек, а не партнёр → его фотолента на Ведаре `/foto/<slug>`,
 *    где slug — транслит имени, как оно записано в подписи. Ни контактов, ни
 *    номера учётной записи в адресе нет: только имя, которое и так стоит под
 *    снимком;
 *  - лента выключена флагом `AUTHOR_PHOTO_FEED=off` → имя текстом.
 *
 * Модуль чистый: его зовут и сервер, и клиентская карточка.
 */
import { operatorPagePath } from '@/lib/operators/page-link';
import { slugify } from '@/lib/text/slugify';

export interface PhotoCredit {
  /** Имя автора — ровно как в подписи. */
  name: string;
  /** Куда ведёт подпись; null — имя текстом. */
  href: string | null;
  /** Чья это страница: партнёра или фотолента автора. */
  kind: 'partner' | 'author_feed' | 'text';
}

/** Включена ли фотолента авторов. По умолчанию — да; `off`/`0`/`false` — нет. */
export function authorFeedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.AUTHOR_PHOTO_FEED ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/** Адрес фотоленты по имени автора; из имени не вышло ни буквы — null. */
export function authorFeedSlug(name: string): string | null {
  const s = slugify(name.trim());
  return s.length >= 2 ? s : null;
}

export function authorFeedPath(name: string): string | null {
  const slug = authorFeedSlug(name);
  return slug ? `/foto/${slug}` : null;
}

/**
 * Подпись принадлежит партнёру: «Партнёр» или «Партнёр. Место съёмки» — та же
 * форма, что у подписей карточки тура (lib/tours/photo-credits).
 */
function byPartner(author: string, partner: string): boolean {
  const a = author.trim().toLocaleLowerCase('ru');
  const p = partner.trim().toLocaleLowerCase('ru');
  return p !== '' && (a === p || a.startsWith(`${p}. `));
}

export interface CreditInput {
  author: string | null | undefined;
  /** Партнёр, чей это снимок (тура или галереи); нет — снимок не партнёра. */
  partner?: { name: string; slug: string | null; isPublic: boolean | null } | null;
  /** Есть ли у автора лента (снимок с лицензией и без внешнего источника). */
  feedEligible: boolean;
  feedEnabled?: boolean;
}

/** Подпись снимка: имя и ссылка. Автора нет — null (подписи нет вовсе). */
export function photoCreditFor(input: CreditInput): PhotoCredit | null {
  const name = (input.author ?? '').trim();
  if (!name) return null;
  if (input.partner && byPartner(name, input.partner.name)) {
    const href = operatorPagePath({ slug: input.partner.slug, is_public: input.partner.isPublic });
    return { name, href, kind: href ? 'partner' : 'text' };
  }
  const enabled = input.feedEnabled ?? authorFeedEnabled();
  const href = enabled && input.feedEligible ? authorFeedPath(name) : null;
  return { name, href, kind: href ? 'author_feed' : 'text' };
}
