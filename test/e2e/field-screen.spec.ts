/**
 * Экран «На маршруте» (/planning?mode=trail) — открывается, и SOS на нём
 * работает, в том числе без сети (26.09).
 *
 * Зачем. Полевой экран — один клиентский файл на ~5 900 строк, который за две
 * недели до этого дня правили 25 раз (16 — прямым пушем в main). Его стерегли
 * 74 теста, и все они читали ТЕКСТ файла; ни один не открывал экран. Сломайся
 * рендер — первым об этом узнал бы турист в поле.
 *
 * Где гоняется:
 *  - в CI каждого PR (job `ci`, после `next build`, без базы) — там экран
 *    обязан открыться так же, как в поле: без данных, на одной оболочке;
 *  - по проду в `e2e-smoke.yml` — с настоящим service worker и прекэшем.
 *
 * Офлайн-проверка ждёт, пока service worker возьмёт страницу под контроль и
 * положит /emergency в кэш: без этого офлайн-перехода нет по построению, и
 * «No internet» от браузера было бы свойством теста, а не дефектом экрана.
 */
import { test, expect, devices, type Page } from '@playwright/test';

test.use({ ...devices['Pixel 5'] });

const FIELD = '/planning?mode=trail';

function sosLink(page: Page) {
  return page.getByRole('link', { name: /SOS — экстренная помощь/ }).first();
}

test.describe('Экран «На маршруте»', () => {
  test('открывается без ошибок, SOS виден в первом экране и не меньше 44px', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const res = await page.goto(FIELD, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    await expect(page.getByText('На маршруте').first()).toBeVisible();

    const sos = sosLink(page);
    await expect(sos).toBeVisible();
    await expect(sos).toHaveAttribute('href', '/sos');
    const box = await sos.boundingBox();
    expect(box, 'у SOS нет размеров — кнопка не отрисована').not.toBeNull();
    if (box) {
      const viewport = page.viewportSize();
      expect(box.y).toBeLessThan(viewport ? viewport.height : 800);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }

    // Дать клиенту дорисоваться: падение эффекта после первого кадра — тоже поломка.
    await page.waitForTimeout(3000);
    expect(errors, `ошибки на странице: ${errors.join(' | ')}`).toEqual([]);
  });

  test('SOS в сети ведёт на /sos', async ({ page }) => {
    await page.goto(FIELD, { waitUntil: 'load' });
    await sosLink(page).click();
    await expect(page).toHaveURL(/\/sos(\?|$)/);
  });

  test('SOS без сети открывает /emergency с номером 112', async ({ page, context }) => {
    test.setTimeout(150_000);
    await page.goto(FIELD, { waitUntil: 'load' });

    // Ждём service worker и прекэш критичного экрана. Не дождались — это
    // отказ, а не пропуск: без него офлайн-SOS не существует.
    await expect.poll(async () => page.evaluate(async () => {
      if (!navigator.serviceWorker?.controller) return false;
      for (const key of await caches.keys()) {
        if (await (await caches.open(key)).match('/emergency')) return true;
      }
      return false;
    }), { timeout: 120_000, intervals: [1000], message: 'service worker не взял страницу или не положил /emergency в кэш' })
      .toBe(true);

    await context.setOffline(true);
    await sosLink(page).click();
    await expect(page).toHaveURL(/\/emergency(\?|$)/, { timeout: 20_000 });
    await expect(page.getByText('112').first()).toBeVisible();
  });
});
