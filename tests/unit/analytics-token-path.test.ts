/**
 * Голосование группы (#3744): токен из адреса /vote/<токен> не попадает в
 * аналитику — ни в page_views, ни в Метрику (ревью безопасности #3744).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripPathToken, stripUrlToken } from '@/lib/analytics/token-path';
import { shouldTrackPath } from '@/lib/analytics/metrika';

const T = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('ключ из адреса в аналитику не идёт', () => {
  it('путь /vote/<токен> → /vote, прочие пути как есть', () => {
    expect(stripPathToken(`/vote/${T}`)).toBe('/vote');
    expect(stripPathToken('/vote')).toBe('/vote');
    expect(stripPathToken('/voters')).toBe('/voters');
    expect(stripPathToken('/catalog/tours/5')).toBe('/catalog/tours/5');
    expect(stripPathToken(undefined)).toBeUndefined();
  });
  it('в полном адресе тоже', () => {
    expect(stripUrlToken(`https://vedarai.ru/vote/${T}?x=1`)).toBe('https://vedarai.ru/vote?x=1');
    expect(stripUrlToken('https://ya.ru/')).toBe('https://ya.ru/');
  });
  it('Метрика на /vote не грузится', () => {
    expect(shouldTrackPath(`/vote/${T}`)).toBe(false);
  });
  it('и трекер, и приёмник hit чистят путь (старый клиент тоже)', () => {
    const tracker = readFileSync('components/shared/PageViewTracker.tsx', 'utf8');
    expect(tracker).toMatch(/path: stripPathToken\(pathname\)/);
    expect(tracker).toMatch(/fromPath: stripPathToken\(prevPath\)/);
    const hit = readFileSync('app/api/analytics/hit/route.ts', 'utf8');
    expect(hit).toMatch(/const path = stripPathToken\(parsed\.data\.path\)/);
    expect(hit).toMatch(/const fromPath = stripPathToken\(parsed\.data\.fromPath\)/);
  });
});
