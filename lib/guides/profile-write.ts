/**
 * Запись профиля гида — одна для кабинета на сайте (`PUT /api/guide/profile`)
 * и кнопки «Сохранить» в чате кабинета (lib/guides/chat-role, слово владельца
 * 30.10 «гид должен полностью управлять своей ролью из MAX»).
 *
 * Схема входа (`UpdateGuideProfileSchema`) — одна: предел «о себе» 5000
 * знаков, опыт 0–60 лет, до 20 языков — у сайта и чата одинаковы.
 *
 * «О себе» пишется в `partners.description` — ту колонку, что читает
 * публичный профиль `/guides/[id]`. users и partners пишутся одной
 * транзакцией вызывающего: `client` — её клиент. Карточка — гида
 * (`category = 'guide'` в самом UPDATE): чужую категорию запись не тронет.
 */

import type { PoolClient } from 'pg';
import { z } from 'zod';

export const GUIDE_SPECIALIZATIONS = [
  'volcanoes', 'wildlife', 'fishing', 'history', 'photography', 'extreme', 'hiking', 'cultural', 'rafting', 'skiing',
] as const;

export const GUIDE_DESCRIPTION_MAX = 5000;
export const GUIDE_EXPERIENCE_MAX = 60;
export const GUIDE_LANGUAGES_MAX = 20;
export const GUIDE_LANGUAGE_LEN = 50;
const EXPERIENCE_RANGE = `Опыт работы — от 0 до ${GUIDE_EXPERIENCE_MAX} лет`;

export const UpdateGuideProfileSchema = z.object({
  name: z.string().trim().min(1, 'Имя не может быть пустым').max(255).optional(),
  partnerName: z.string().trim().min(1, 'Название не может быть пустым').max(255).optional(),
  description: z.string().max(GUIDE_DESCRIPTION_MAX, `Текст «О себе» — не длиннее ${GUIDE_DESCRIPTION_MAX} символов`).optional(),
  /** Телефон: пустая строка — явная очистка (ключ удаляется из contact). */
  phone: z.string().trim().max(30, 'Телефон — не длиннее 30 символов').optional(),
  experienceYears: z.number().int().min(0, EXPERIENCE_RANGE).max(GUIDE_EXPERIENCE_MAX, EXPERIENCE_RANGE).nullable().optional(),
  languages: z.array(z.string().trim().min(1).max(GUIDE_LANGUAGE_LEN)).max(GUIDE_LANGUAGES_MAX).optional(),
  specializations: z.array(z.enum(GUIDE_SPECIALIZATIONS)).optional(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
  isAvailable: z.boolean().optional(),
  /** Отправить профиль на проверку платформы (none/rejected → pending). */
  submitForReview: z.boolean().optional(),
});

export type GuideProfilePatch = z.infer<typeof UpdateGuideProfileSchema>;

/**
 * Записать правку профиля в транзакции вызывающего. `userId` нужен только
 * для имени аккаунта (`name`); `false` — карточки гида с таким id нет, в
 * partners ничего не записано.
 */
export async function writeGuideProfilePatch(
  client: Pick<PoolClient, 'query'>,
  args: { partnerId: string; userId: string | null; patch: GuideProfilePatch },
): Promise<boolean> {
  const {
    name, partnerName, description, phone, experienceYears,
    languages, specializations, location, isAvailable, submitForReview,
  } = args.patch;

  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (sql: (idx: number) => string, value: unknown) => {
    values.push(value);
    sets.push(sql(values.length));
  };

  if (partnerName !== undefined) set((i) => `name = $${i}`, partnerName);
  if (description !== undefined) set((i) => `description = $${i}`, description);
  if (phone !== undefined) {
    // Пустая строка — очистка: ключ удаляется, а не остаётся старый номер.
    if (phone === '') sets.push(`contact = COALESCE(contact, '{}'::jsonb) - 'phone'`);
    else set((i) => `contact = COALESCE(contact, '{}'::jsonb) || jsonb_build_object('phone', $${i}::text)`, phone);
  }
  if (experienceYears !== undefined) set((i) => `experience_years = $${i}`, experienceYears);
  if (languages !== undefined) set((i) => `languages = $${i}::text[]`, languages);
  if (specializations !== undefined) set((i) => `specializations = $${i}::text[]`, specializations);
  if (location !== undefined) set((i) => `location = $${i}::jsonb`, location === null ? null : JSON.stringify(location));
  if (isAvailable !== undefined) set((i) => `is_available = $${i}`, isAvailable);
  if (submitForReview) {
    // Заявка подаётся только из «не подана» или «отклонена»; одобренного
    // гида повторная отправка не откатывает на проверку.
    sets.push(`applied_at = CASE WHEN profile_status IN ('none', 'rejected') THEN NOW() ELSE applied_at END`);
    sets.push(`profile_status = CASE WHEN profile_status IN ('none', 'rejected') THEN 'pending' ELSE profile_status END`);
  }

  if (name !== undefined && args.userId) {
    await client.query('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2', [name, args.userId]);
  }
  if (sets.length === 0) return true;
  values.push(args.partnerId);
  const r = await client.query(
    `UPDATE partners SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} AND category = 'guide'`,
    values,
  );
  return (r.rowCount ?? 0) > 0;
}
