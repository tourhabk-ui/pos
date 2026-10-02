/**
 * Карточка каталога получает выдержку описания, а не статью целиком (аудит 01.10).
 *
 * Первый HTML /routes весил 970 КБ: 397 КБ — полные тексты 23 карточек при
 * видимых двух строках, и столько же ещё раз в данных гидратации.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withCardExcerpts, CARD_DESCRIPTION_MAX } from '@/lib/routes/card-excerpt';

describe('выдержка описания карточки', () => {
  it('длинный текст режется до предела, по предложению или слову', () => {
    const long = 'Камчатка входит в область Тихоокеанского огненного кольца. ' + 'Здесь частые землетрясения и извержения. '.repeat(500);
    const [it1] = withCardExcerpts([{ id: 1, description: long }]);
    expect(it1.description.length).toBeLessThanOrEqual(CARD_DESCRIPTION_MAX + 1);
    expect(it1.description.startsWith('Камчатка входит в область')).toBe(true);
    expect(long.length).toBeGreaterThan(10_000);
  });

  it('короткий текст и остальные поля не трогаются', () => {
    const items = [{ id: 'a', title: 'Вулкан Горелый', description: 'Короткое описание.' }];
    expect(withCardExcerpts(items)).toEqual(items);
  });

  it('обе страницы каталога отдают клиенту выдержки', () => {
    for (const f of ['app/routes/(list)/page.tsx', 'app/places/page.tsx']) {
      expect(readFileSync(f, 'utf-8'), f).toMatch(/initialItems=\{withCardExcerpts\(initial\?\.items \?\? \[\]\)\}/);
    }
  });
});
