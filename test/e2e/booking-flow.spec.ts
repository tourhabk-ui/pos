/**
 * Путь туриста к покупке: каталог → карточка тура → заявка.
 *
 * ── Почему спека переписана 12.09 ─────────────────────────────────────────
 *
 * Она не вызывалась ни одним workflow с 14.08 (#1833), и когда её наконец
 * запустили, упали все три теста. Разбор показал две разные болезни, и
 * вторая хуже первой.
 *
 * 1. `waitForLoadState('networkidle')` в каждом тесте. На наших страницах
 *    сеть не затихает: карта тянет тайлы, статус безопасности опрашивается.
 *    Ожидание висело до таймаута — 14 минут на три теста с ретраями. Playwright
 *    сам не советует networkidle; здесь он и не нужен.
 *
 * 2. Тесты почти ничего не утверждали. `routes page shows tour cards`
 *    проверял `body.length > 100` — столько есть и на странице ошибки.
 *    `individual route page loads` и `booking modal requires auth` были
 *    целиком обёрнуты в `if (await X.isVisible())`: не нашли элемент —
 *    тест зелёный. Тот же дефект, что чинили в smoke 17.08: «пропуск
 *    выглядит зелёным».
 *
 * Здесь пропусков нет: чего нет — то падение.
 *
 * ── Почему заявка проверяется на ТУРЕ, а не на маршруте ───────────────────
 *
 * Прежний тест искал кнопку брони на `/routes/*`. Её там нет и быть не
 * должно: маршрут — инструкция, тур — коммерция (CLAUDE.md §9-§11, на
 * карточке точки и маршрута цены и брони нет намеренно). То есть тест
 * годами искал кнопку там, где её запрещено рисовать, и молчал об этом
 * своим `if`. Теперь он идёт в каталог, как идёт человек.
 */
import { test, expect } from '@playwright/test';

test.describe('Каталог и карточка тура', () => {
  test('каталог отдаёт список туров, а не пустоту', async ({ page }) => {
    const res = await page.goto('/catalog');
    expect(res?.status(), 'каталог обязан отвечать 200').toBe(200);

    // Пустой каталог — тоже регрессия: живые туры на проде есть (§4.1).
    // Решение то же, что принято для smoke 17.08.
    const tourLinks = page.locator('a[href*="/tours/"]');
    await expect(tourLinks.first(), 'в каталоге нет ни одной карточки тура').toBeVisible({
      timeout: 15_000,
    });
  });

  test('карточка тура открывается и показывает цену', async ({ page }) => {
    await page.goto('/catalog');
    const first = page.locator('a[href*="/tours/"]').first();
    await expect(first, 'в каталоге нет ни одной карточки тура').toBeVisible({ timeout: 15_000 });

    const href = await first.getAttribute('href');
    expect(href, 'у карточки тура нет адреса').toBeTruthy();
    await page.goto(href!);

    await expect(page.locator('h1').first(), 'у карточки тура нет заголовка').toBeVisible({
      timeout: 15_000,
    });
    // Цена — то, ради чего карточка тура отличается от карточки маршрута.
    await expect(page.locator('body'), 'на карточке тура не видно цены').toContainText('₽');
  });
});

test.describe('Публичные API витрины', () => {
  test('GET /api/tours отдаёт список', async ({ request }) => {
    const res = await request.get('/api/tours');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body, 'ответ /api/tours не похож на список туров').toBeTruthy();
  });

  test('GET /api/bookings без токена — 401', async ({ request }) => {
    const res = await request.get('/api/bookings');
    expect([401, 403], `бронирования отдаются без авторизации: ${res.status()}`).toContain(
      res.status(),
    );
  });

  test('POST /api/bookings без токена — 401', async ({ request }) => {
    const res = await request.post('/api/bookings', { data: { tourId: 'e2e-probe' } });
    expect([400, 401, 403], `бронь создаётся без авторизации: ${res.status()}`).toContain(
      res.status(),
    );
  });

  test('GET /api/discovery/search отвечает', async ({ request }) => {
    const res = await request.get('/api/discovery/search?q=вулкан');
    expect(res.status()).toBeLessThan(500);
  });
});
