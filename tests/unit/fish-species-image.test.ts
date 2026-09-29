/**
 * Изображения видов рыб (29.09): файл лежит в public/images, а не на чужом
 * хосте (CLAUDE.md §3), и страница вида его действительно выводит — поле
 * справочника без читателя было бы объявлением без источника (§10.09).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FISH_SPECIES, FISH_BY_ID } from '@/lib/fish-species';

describe('изображения видов рыб', () => {
  it('у микижи изображение есть', () => {
    expect(FISH_BY_ID['mikizha']?.image?.src).toBe('/images/fish/mikizha.jpg');
  });

  it('каждое изображение — локальный файл из public/images с непустым alt', () => {
    for (const f of FISH_SPECIES) {
      if (!f.image) continue;
      expect(f.image.src, f.id).toMatch(/^\/images\//);
      expect(existsSync(join(process.cwd(), 'public', f.image.src)), f.image.src).toBe(true);
      expect(f.image.alt.trim().length, f.id).toBeGreaterThan(10);
    }
  });

  it('страница вида выводит изображение', () => {
    const src = readFileSync(join(process.cwd(), 'app/fish/[id]/page.tsx'), 'utf-8');
    expect(src).toMatch(/species\.image\.src/);
    expect(src).toMatch(/species\.image\.alt/);
  });
});
