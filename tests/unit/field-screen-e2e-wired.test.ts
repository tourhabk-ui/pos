/**
 * Браузерная проверка экрана «На маршруте» не только написана, но и
 * вызывается (§10.09: объявленное без вызова — провод в никуда).
 * Спека — test/e2e/field-screen.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('e2e экрана «На маршруте» подключён', () => {
  const spec = read('test/e2e/field-screen.spec.ts');

  it('спека открывает полевой экран и проверяет SOS в сети и без неё', () => {
    expect(spec).toContain("'/planning?mode=trail'");
    expect(spec).toContain('SOS — экстренная помощь');
    expect(spec).toContain('setOffline(true)');
    expect(spec).toMatch(/toHaveURL\(\/\\\/emergency/);
  });

  it('job ci гоняет её после сборки на своём сервере', () => {
    const ci = read('.github/workflows/ci.yml');
    const build = ci.indexOf('- name: Build (Next.js)');
    const run = ci.indexOf('test/e2e/field-screen.spec.ts');
    expect(build).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(build);
    expect(ci).toContain('E2E_EXTERNAL_SERVER=1');
  });

  it('конфиг Playwright понимает внешний сервер', () => {
    expect(read('playwright.config.ts')).toMatch(/E2E_EXTERNAL_SERVER === '1'/);
  });

  it('ночной smoke по проду тоже её гоняет — там настоящий прекэш', () => {
    expect(read('.github/workflows/e2e-smoke.yml')).toContain('test/e2e/field-screen.spec.ts');
  });
});
