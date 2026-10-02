/**
 * Плитки мест на главной ведут по ЧПУ, а не по UUID (аудит 02.10: главная
 * давала две ссылки вида /places/20d7b84d-…, каждая — 308 на slug).
 * Источник slug тот же, что у каталога (`urlSlug` из lib/routes/catalog-query);
 * нет slug — ссылка по id, как раньше.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('плитки «Открыть» на главной', () => {
  it('данные несут urlSlug из каталога', () => {
    const data = readFileSync('app/_home/data.ts', 'utf-8');
    expect(data).toMatch(/urlSlug: string \| null;/);
    expect(data).toMatch(/urlSlug: it\.urlSlug \?\? null,/);
  });

  it('ссылка — по slug, по id только когда slug нет', () => {
    const client = readFileSync('app/_home/_HomeV8Client.tsx', 'utf-8');
    expect(client).toContain('href={`/places/${pl.urlSlug ?? pl.id}`}');
    expect(client).not.toContain('href={`/places/${pl.id}`}');
  });
});
