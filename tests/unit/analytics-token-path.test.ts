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

describe('и в журнал ошибок клиента ключ не идёт (ревью #3744, заход 2)', () => {
  it('pathOnly режет /vote/<токен>', async () => {
    const { pathOnly } = await import('@/lib/client-errors/scrub');
    expect(pathOnly(`/vote/${T}`)).toBe('/vote');
    expect(pathOnly(`https://vedarai.ru/vote/${T}?a=1#b`)).toBe('/vote');
    expect(pathOnly('/catalog/tours/5?x=1')).toBe('/catalog/tours/5');
    expect(pathOnly(`/api/trip-vote/${T}`)).toBe('/api/trip-vote');
    const inst = readFileSync('instrumentation.ts', 'utf8');
    expect(inst).toMatch(/scrubErrorText\(pathOnly\(request\?\.path\)/);
    expect(inst).toMatch(/context\?\.routePath \|\| pathOnly\(request\?\.path\)/);
    expect(inst).not.toMatch(/\(request\?\.path \?\? ''\)\.split/);
    expect(readFileSync('lib/server-errors/digest.ts', 'utf8').match(/stripPathToken\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it('публичная ссылка голосования гаснет через 3 дня после срока', () => {
    const src = readFileSync('app/api/trip-vote/[token]/route.ts', 'utf8');
    expect(src).toMatch(/l\.deadline_at > now\(\) - interval '3 days'/);
  });
});
