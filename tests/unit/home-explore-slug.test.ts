/**
 * Плитки мест на главной ведут по ЧПУ, а не по UUID (аудит 02.10: главная
 * давала две ссылки вида /places/20d7b84d-…, каждая — 308 на slug).
 * Источник slug тот же, что у каталога (`urlSlug` из lib/routes/catalog-query);
 * нет slug — ссылка по id, как раньше.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { placeHref } from '@/components/places/PlaceSwipeDeck';

describe('плитки «Открыть» на главной', () => {
  it('данные несут urlSlug из каталога', () => {
    const data = readFileSync('app/_home/data.ts', 'utf-8');
    expect(data).toMatch(/urlSlug: string \| null;/);
    expect(data).toMatch(/urlSlug: it\.urlSlug \?\? null,/);
  });

  it('ссылка — по slug, по id только когда slug нет', () => {
    // С 12.11 места на главной — колодой (components/places/PlaceSwipeDeck):
    // ссылку строит её placeHref, рендер ссылки — tests/unit/motion-kit.test.tsx.
    const client = readFileSync('app/_home/_HomeV8Client.tsx', 'utf-8');
    expect(client).toMatch(/places=\{explore\}/);
    expect(client).not.toContain('href={`/places/${pl.id}`}');
    expect(placeHref({ id: 'uuid-1', urlSlug: 'vulkan-gorelyj' })).toBe('/places/vulkan-gorelyj');
    expect(placeHref({ id: 'uuid-1', urlSlug: null })).toBe('/places/uuid-1');
  });
});
