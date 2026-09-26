/**
 * Публичная страница жилья не раздаёт ПД авторов отзывов (26.09).
 *
 * GET /api/accommodations/[id] — публичный роут (lib/auth/public-api-routes)
 * и отдавал reviews[].user.email каждого автора: адреса гостей собирались
 * перебором id объектов. Теперь — только имя и первая буква фамилии.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicReviewerName } from '@/lib/reviews/public-name';

const src = readFileSync(join(process.cwd(), 'app/api/accommodations/[id]/route.ts'), 'utf-8');

describe('отзывы о жилье без ПД', () => {
  it('email автора не выбирается и не отдаётся', () => {
    expect(src).not.toMatch(/u\.email/);
    expect(src).not.toMatch(/email:\s*review\./);
  });

  it('имя — через publicReviewerName', () => {
    expect(src).toMatch(/name: publicReviewerName\(review\.user_name\)/);
  });

  it('имя и первая буква фамилии; пусто — «Гость»', () => {
    expect(publicReviewerName('Иван Петров')).toBe('Иван П.');
    expect(publicReviewerName('  Мария  ')).toBe('Мария');
    expect(publicReviewerName(null)).toBe('Гость');
    expect(publicReviewerName('')).toBe('Гость');
  });
});
