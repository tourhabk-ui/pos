/**
 * Владелец жилья без отзывов — «не оценён» (NULL), а не 0 (§4.0).
 *
 * partners.rating имеет умолчание 0.0, и все пути заведения партнёра
 * писали владельцу жилья ноль: явно (ensurePartnerForRole, регистрация)
 * или молча умолчанием колонки (регистрация партнёра, заявка оператора,
 * ручное заведение администратором). Отзывы ставят от 1 до 5 — ноль не
 * может быть ничьей оценкой. Миграция 1027 чистит уже заведённых.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { initialPartnerRating } from '@/lib/partners/categories';

const read = (p: string) => readFileSync(p, 'utf-8');

describe('рейтинг нового партнёра жилья — NULL', () => {
  it('справочник: stay → null, прочие → прежний 0', () => {
    expect(initialPartnerRating('stay')).toBeNull();
    expect(initialPartnerRating('operator')).toBe(0);
    expect(initialPartnerRating('guide')).toBe(0);
  });

  it('SQL-писатели формы «вставь, если нет» пишут stay NULL', () => {
    for (const f of ['lib/auth/partner-profile.ts', 'app/api/auth/register/route.ts']) {
      expect(read(f), f).toContain("CASE WHEN $3::varchar = 'stay' THEN NULL ELSE 0 END");
      expect(read(f), f).not.toMatch(/false, 0, 0, NOW\(\)/);
    }
  });

  it('пути с VALUES передают rating явно через initialPartnerRating', () => {
    for (const f of [
      'app/api/partners/register/route.ts',
      'app/api/auth/register-operator/route.ts',
      'app/api/admin/operators/create/route.ts',
    ]) {
      const src = read(f);
      expect(src, f).toContain('initialPartnerRating(');
      const insert = src.slice(src.indexOf('INSERT INTO partners'));
      expect(insert.slice(0, 600), f).toMatch(/\brating\b/);
    }
  });

  it('миграция 1027 чистит ноль без отзывов только у жилья', () => {
    const m = read('migrations/1027_accommodation_moderation.sql');
    expect(m).toMatch(/UPDATE partners\s+SET rating = NULL\s+WHERE category = 'stay'\s+AND rating = 0\s+AND COALESCE\(review_count, 0\) = 0/);
  });
});
