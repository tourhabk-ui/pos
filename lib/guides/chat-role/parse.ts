/**
 * Разбор фразы гида о правке профиля — правилами, без модели (слово
 * владельца 30.10 «гид должен полностью управлять своей ролью из MAX»).
 *
 * Формы:
 *   о себе: Вожу на вулканы с 2010 года…
 *   опыт: 12            (или «опыт 12 лет», «опыт работы: 12»)
 *   языки: русский, английский
 *
 * Слова поля не пересекаются со словами правки тура (lib/guides/tour-edit/parse):
 * «описание» и «название» — поля тура. Фраза другой формы — `null`: сообщение
 * идёт дальше своим путём. Значение, которое записать нельзя (пусто, длинно,
 * опыт не числом), — отказ с причиной: модель такую фразу не получает, иначе
 * сказала бы «сохранил», ничего не сохранив.
 *
 * Пределы — схемы сайта (`UpdateGuideProfileSchema`, lib/guides/profile-write).
 */

import {
  GUIDE_DESCRIPTION_MAX, GUIDE_EXPERIENCE_MAX, GUIDE_LANGUAGE_LEN, GUIDE_LANGUAGES_MAX,
} from '@/lib/guides/profile-write';

export const PROFILE_FIELDS = ['description', 'experience_years', 'languages'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type ProfileValue = string | number | string[];

export const PROFILE_LABEL: Readonly<Record<ProfileField, string>> = {
  description: 'О себе',
  experience_years: 'Опыт',
  languages: 'Языки',
};

export type ProfileReject =
  | { reason: 'empty' }
  | { reason: 'too_long'; max: number; got: number }
  | { reason: 'bad_years' }
  | { reason: 'too_many'; max: number; got: number }
  | { reason: 'item_too_long'; index: number; max: number };

export type ProfileParse =
  | { ok: true; field: ProfileField; value: ProfileValue }
  | ({ ok: false; field: ProfileField } & ProfileReject);

const HEADS: ReadonlyArray<[RegExp, ProfileField]> = [
  [/^о\s+себе\s*:/i, 'description'],
  [/^опыт(?:\s+работы)?\s*:/i, 'experience_years'],
  [/^опыт(?:\s+работы)?(?=\s+\d)/i, 'experience_years'],
  [/^языки\s*:/i, 'languages'],
];

export function parseProfileEdit(raw: string): ProfileParse | null {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text || text.startsWith('/')) return null;
  for (const [re, field] of HEADS) {
    const m = re.exec(text);
    if (!m) continue;
    const body = text.slice(m[0].length).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!body) return { ok: false, field, reason: 'empty' };
    if (field === 'description') {
      if (body.length > GUIDE_DESCRIPTION_MAX) return { ok: false, field, reason: 'too_long', max: GUIDE_DESCRIPTION_MAX, got: body.length };
      return { ok: true, field, value: body };
    }
    if (field === 'experience_years') {
      const y = /^(\d{1,2})\s*(?:лет|год|года|г\.?)?\s*\.?$/i.exec(body);
      const n = y ? Number(y[1]) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > GUIDE_EXPERIENCE_MAX) return { ok: false, field, reason: 'bad_years' };
      return { ok: true, field, value: n };
    }
    const items = body.split(/[,;\n/]+/).map((s) => s.replace(/^[-–—•*·]\s*/, '').trim()).filter((s) => s.length > 0);
    const seen = new Set<string>();
    const uniq = items.filter((s) => {
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (uniq.length === 0) return { ok: false, field, reason: 'empty' };
    if (uniq.length > GUIDE_LANGUAGES_MAX) return { ok: false, field, reason: 'too_many', max: GUIDE_LANGUAGES_MAX, got: uniq.length };
    const long = uniq.findIndex((s) => s.length > GUIDE_LANGUAGE_LEN);
    if (long >= 0) return { ok: false, field, reason: 'item_too_long', index: long + 1, max: GUIDE_LANGUAGE_LEN };
    return { ok: true, field, value: uniq };
  }
  return null;
}
