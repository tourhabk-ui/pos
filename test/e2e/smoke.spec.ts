import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('homepage loads and has title', async ({ page }) => {
    await page.goto('/');
    // Основа слова, а не словоформа: заголовок главной — «Ведар — помощник и
    // планировщик путешествия по Камчатке», и «Камчатка» в него не попадает.
    // Шесть ночей подряд smoke падал на падеже (04-09.08), и это хуже, чем
    // просто шум: сторож, который кричит впустую, перестают читать, а следом
    // не заметят настоящую регрессию.
    await expect(page).toHaveTitle(/Ведар|TourHab|Камчатк/i);
  });

  test('homepage has hero section', async ({ page }) => {
    await page.goto('/');
    const hero = page.locator('section').first();
    await expect(hero).toBeVisible();
  });

  test('homepage has navigation', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('header, nav').first();
    await expect(nav).toBeVisible();
  });

  test('routes page loads', async ({ page }) => {
    await page.goto('/routes');
    await expect(page.locator('body')).toContainText(/маршрут|тур|route/i);
  });

  test('map page loads', async ({ page }) => {
    await page.goto('/map');
    await expect(page).toHaveURL(/map/);
  });

  test('auth page loads', async ({ page }) => {
    // Именно /auth/login. Страницы /auth не существует — это сегмент с одним
    // layout, и прод честно отдавал на неё 404, а smoke считал это поломкой
    // входа. Тот же адрес стоит в middleware, куда уводит неавторизованных.
    await page.goto('/auth/login');
    await expect(page.locator('body')).toContainText(/вход|регистрация|войти/i);
  });

  test('safety page loads', async ({ page }) => {
    await page.goto('/safety');
    await expect(page.locator('body')).toContainText(/безопасность|SOS|safety/i);
  });
});

test.describe('API Smoke Tests', () => {
  test('GET /api/routes returns JSON', async ({ request }) => {
    const res = await request.get('/api/routes');
    expect(res.status()).toBeLessThan(500);
    expect(res.headers()['content-type']).toContain('application/json');
  });

  test('GET /api/public/stats returns data', async ({ request }) => {
    const res = await request.get('/api/public/stats');
    expect(res.status()).toBeLessThan(500);
  });

  test('GET /api/weather returns data', async ({ request }) => {
    const res = await request.get('/api/weather');
    expect(res.status()).toBeLessThan(500);
  });

  test('POST /api/leads accepts lead', async ({ request }) => {
    // Мутирующий тест: создаёт лид (Telegram-алерт, watchdog, AI-обработчик).
    // В прод-smoke (SMOKE_READONLY=1) пропускаем, чтобы не сорить боевыми лидами —
    // прогоняется только локально/на тестовой БД.
    test.skip(process.env.SMOKE_READONLY === '1', 'мутирующий — пропущен в read-only прод-smoke');
    const res = await request.post('/api/leads', {
      data: {
        name: 'E2E Test',
        phone: '+79001234567',
        source: 'e2e-test',
      },
    });
    // Should not be 500 (may be 400 if validation fails, that's ok)
    expect(res.status()).toBeLessThan(500);
  });

  test('protected API returns 401 without auth', async ({ request }) => {
    const res = await request.get('/api/admin/operators');
    expect(res.status()).toBe(401);
  });
});
