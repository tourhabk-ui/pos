import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siteVerification, BING_SITE_VERIFICATION } from '@/lib/seo/site-verification';

/**
 * Подтверждения владения сайтом (Bing — тег владельца 15.10). Bing
 * перепроверяет тег время от времени: если он пропадёт со страницы,
 * подтверждение и отчёты вебмастера уйдут молча.
 */
describe('подтверждение сайта для вебмастеров', () => {
  it('Bing получает свой тег msvalidate.01 — значение, присланное владельцем', () => {
    const v = siteVerification({} as NodeJS.ProcessEnv);
    expect(v.other?.['msvalidate.01']).toBe('4760A4B34058EAD4A55163A872643739');
    expect(BING_SITE_VERIFICATION).toMatch(/^[0-9A-F]{32}$/);
  });

  it('Google и Яндекс по-прежнему из переменных окружения; без них — пусто, а не выдумка', () => {
    const withEnv = siteVerification({ GOOGLE_SITE_VERIFICATION: 'g-token', YANDEX_VERIFICATION: 'y-token' } as NodeJS.ProcessEnv);
    expect(withEnv.google).toBe('g-token');
    expect(withEnv.yandex).toBe('y-token');
    const empty = siteVerification({} as NodeJS.ProcessEnv);
    expect(empty.google).toBeUndefined();
    expect(empty.yandex).toBeUndefined();
  });

  it('запрет: корневой layout не собирает блок verification руками — только через siteVerification()', () => {
    const layout = readFileSync(join(process.cwd(), 'app/layout.tsx'), 'utf8');
    expect(layout).not.toMatch(/verification:\s*\{/);
    expect(layout).not.toMatch(/process\.env\.(GOOGLE_SITE_VERIFICATION|YANDEX_VERIFICATION)/);
  });
});
