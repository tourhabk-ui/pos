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
    // Именно 200, а не «меньше пятисот». Прежний порог считал нормой и 404, и
    // 401: каталог, отвечающий «не найдено» на всё, проходил проверку молча.
    // Своя ручка — внешних зависимостей у неё нет, и мягкость здесь ничего не
    // защищает, кроме поломки.
    expect(res.status()).toBe(200);
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

/**
 * Карточка маршрута открывается С ДАННЫМИ.
 *
 * ── Зачем эта группа появилась ─────────────────────────────────────────────
 *
 * 18.08 карточка маршрута на проде перестала открываться: код читал колонку
 * `link_kind`, а миграция 874 не применилась, и `/api/routes/[id]` отвечал
 * пятисоткой. Экран честно писал «Маршрут не открылся — сервер не отдал
 * данные». Ночной smoke в ту же ночь был ЗЕЛЁНЫЙ.
 *
 * Он и не мог покраснеть: ни одна проверка не открывала карточку маршрута, а
 * `status < 500` считает нормой и 404, и 401. То есть smoke проверял, что
 * сервер отвечает, а не что он отвечает ПРАВДОЙ. Для платформы, где по
 * карточке идут в поле, это разные вещи.
 *
 * ── Почему без переменной окружения ────────────────────────────────────────
 *
 * Идентификатор берётся из живого каталога, а не из настройки вроде
 * `SMOKE_ROUTE_ID`. Настройка, которую забыли задать, превращает проверку в
 * пропуск — а пропущенная проверка выглядит зелёной. Пустой каталог здесь
 * тоже РЕГРЕССИЯ, а не повод молчать: витрина без единого маршрута — это
 * поломка, о которой обязан сказать именно smoke.
 */
test.describe('Route card smoke', () => {
  test('карточка маршрута отдаётся с данными и открывается', async ({ page, request }) => {
    const listRes = await request.get('/api/routes?kind=route&limit=1');
    expect(listRes.status(), 'каталог маршрутов не ответил').toBe(200);
    const list = await listRes.json() as {
      success?: boolean;
      data?: Array<{ id?: string; title?: string }>;
    };
    expect(list.success, 'каталог ответил отказом').toBe(true);
    const first = list.data?.[0];
    // Пустая витрина — регрессия. Пропустить проверку здесь значило бы
    // отчитаться зелёным именно в тот момент, когда каталог пуст.
    expect(first?.id, 'в каталоге нет ни одного маршрута').toBeTruthy();

    const cardRes = await request.get(`/api/routes/${first!.id}`);
    expect(cardRes.status(), 'карточка маршрута ответила ошибкой').toBe(200);
    const card = await cardRes.json() as { success?: boolean; data?: { title?: string } };
    expect(card.success, 'карточка ответила отказом').toBe(true);
    // Название — минимальный признак того, что данные ЕСТЬ, а не что ответ
    // синтаксически похож на успех.
    expect(card.data?.title, 'карточка пришла без названия').toBeTruthy();

    await page.goto(`/routes/${first!.id}`);
    await expect(page.locator('body')).not.toContainText(/не отдал данные|не открылся/i);
    await expect(page.locator('h1').first()).toBeVisible();
  });
});
