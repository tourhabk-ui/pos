/**
 * Сторож миграции 807: в витрине только туры двух реальных партнёров
 * («Камчатка Рафтинг» и «Камчатская Рыбалка»). Всё прочее — скрыть, но ОБРАТИМО
 * (unpublish, не delete). Ловит регресс, где чужой/демо-тур снова оказался бы
 * опубликован без привязки к партнёру.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'migrations/807_only_real_partners_visible.sql'),
  'utf-8',
);

describe('миграция 807 — витрина только реальных партнёров', () => {
  it('оставляет видимыми обоих реальных партнёров', () => {
    expect(src).toContain("p.slug = 'kamchatka-rafting'");
    expect(src).toMatch(/'fishingkam'|'kamchatskaya-rybalka'|'rybalka-po-kamchatski'/);
    expect(src).toMatch(/name ILIKE '%камчатская рыбалка%'/i);
  });

  it('прячет туры, чей оператор НЕ реальный партнёр (через NOT EXISTS)', () => {
    expect(src).toMatch(/NOT EXISTS/);
    expect(src).toContain('FROM partners p');
    expect(src).toContain('p.id = ot.operator_id');
    expect(src).toMatch(/is_published\s*=\s*FALSE/);
    expect(src).toMatch(/is_active\s*=\s*FALSE/);
  });

  it('обратимо: не удаляет и не трогает deleted_at', () => {
    expect(src).not.toMatch(/\bDELETE\b/i);
    expect(src).not.toMatch(/deleted_at\s*=/);
  });

  it('идемпотентна: трогает только сейчас-видимые туры', () => {
    expect(src).toMatch(/is_published = TRUE OR ot\.is_active = TRUE/);
  });
});
