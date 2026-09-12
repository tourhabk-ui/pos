/**
 * Мобильная вёрстка, периметр авторизации и базовая скорость.
 *
 * ── Что чинилось 12.09 ────────────────────────────────────────────────────
 *
 * Спека не вызывалась ни одним workflow с 14.08 (#1833). Первый же прогон:
 * блоки «Critical Security» и «Performance Baseline» прошли целиком, а все
 * три теста мобильной вёрстки упали. Причина у всех трёх одна и не про
 * вёрстку — `waitForLoadState('networkidle')`: на наших страницах сеть не
 * затихает (карта тянет тайлы, опрашивается статус безопасности), ожидание
 * висело до таймаута. Показательно, что `homepage loads under 5 seconds`
 * из того же файла проходил — он один и ждал `domcontentloaded`.
 *
 * Отдельно: `mobile bottom nav visible on homepage` вычислял `exists` и
 * НИКОГДА его не использовал — утверждал только, что у страницы есть
 * заголовок. Имя теста обещало проверку таб-бара, проверки не было.
 */
import { test, expect } from '@playwright/test';

test.describe('Mobile Responsiveness', () => {
  test.use({ viewport: { width: 375, height: 812 } }); // iPhone X

  test('на телефоне нет горизонтальной прокрутки', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('header, nav').first()).toBeVisible({ timeout: 15_000 });

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, 'страница уезжает вбок на 375px').toBeLessThanOrEqual(clientWidth + 5);
  });

  test('таб-бар виден на главной', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Селектор — по роли и подписи, как у человека со скринридером:
    // components/shared/BottomNav.tsx, aria-label «Основная навигация».
    // Прежний тест искал `nav[class*="bottom"]` и результат выбрасывал.
    const nav = page.getByRole('navigation', { name: 'Основная навигация' });
    await expect(nav, 'таб-бара нет на главной — с телефона платформа без навигации').toBeVisible({
      timeout: 15_000,
    });
  });

  test('страница маршрутов открывается на телефоне', async ({ page }) => {
    const res = await page.goto('/routes', { waitUntil: 'domcontentloaded' });
    expect(res?.status(), '/routes обязан отвечать 200').toBe(200);
    // Прежде проверялось `body.length > 50` — столько есть и на странице
    // ошибки. Спрашиваем то, ради чего на страницу заходят.
    await expect(page.locator('a[href*="/routes/"]').first(), 'список маршрутов пуст').toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe('Critical Security', () => {
  test('admin routes return 401 without token', async ({ request }) => {
    const endpoints = [
      '/api/admin/operators',
      '/api/admin/users',
      '/api/admin/content/tours',
      '/api/admin/finance/payouts',
    ];
    for (const ep of endpoints) {
      const res = await request.get(ep);
      expect(res.status(), `${ep} should require auth`).toBeGreaterThanOrEqual(401);
      expect(res.status(), `${ep} should not be 500`).toBeLessThan(500);
    }
  });

  test('operator routes return 401 without token', async ({ request }) => {
    const endpoints = [
      '/api/operator/tours',
      '/api/operator/bookings',
      '/api/operator/profile',
    ];
    for (const ep of endpoints) {
      const res = await request.get(ep);
      expect(res.status(), `${ep} should require auth`).toBeGreaterThanOrEqual(401);
    }
  });

  test('agent routes return 401 without token', async ({ request }) => {
    const res = await request.post('/api/agents/board-meeting');
    expect(res.status()).toBeGreaterThanOrEqual(401);
  });

  test('no server info leak in headers', async ({ request }) => {
    const res = await request.get('/');
    const headers = res.headers();
    // Should not expose server version details
    expect(headers['x-powered-by']).toBeUndefined();
  });
});

test.describe('Performance Baseline', () => {
  test('homepage loads under 5 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  test('API response under 3 seconds', async ({ request }) => {
    const start = Date.now();
    await request.get('/api/routes');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});
