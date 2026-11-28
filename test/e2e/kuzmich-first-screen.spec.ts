import { test, expect } from '@playwright/test';

/**
 * /kuzmich: поле ввода в первом экране, без прокрутки (слово владельца 28.11:
 * «Я еле нашёл строку ввода»).
 *
 * Ручная проверка, в CI не подключена (задание 28.11). Ничего не вводит и не
 * отправляет. Запуск:
 *   npx playwright test test/e2e/kuzmich-first-screen.spec.ts --project=chromium
 * против прода, после выката:
 *   BASE_URL=https://vedarai.ru npx playwright test test/e2e/kuzmich-first-screen.spec.ts --project=chromium
 *
 * 140 px снизу — запас под плашку согласия на cookie: поле ввода должно
 * стоять выше неё. Адреса ботов — те же, что KUZMICH_TELEGRAM_URL и
 * KUZMICH_MAX_URL в components/shared/KuzmichActions.tsx (сверяет
 * tests/unit/kuzmich-page-2211.test.tsx).
 */
const TELEGRAM = 'https://t.me/kuzmichai_bot?start=lead';
const MAX = 'https://max.ru/id4101147649_bot?start=lead';
const COOKIE_RESERVE = 140;

for (const viewport of [{ width: 390, height: 664 }, { width: 1280, height: 720 }]) {
  test(`/kuzmich ${viewport.width}×${viewport.height}: поле ввода в первом экране`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/kuzmich');

    const input = page.locator('[data-kuzmich-input] input[type=text]');
    await expect(input).toBeVisible();
    const box = await input.boundingBox();
    expect(box, 'у поля ввода нет размеров').not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - COOKIE_RESERVE);

    // Знаки под заголовком; те же адреса стоят ещё и в тексте описания.
    await expect(page.locator(`a[href="${TELEGRAM}"][data-kuzmich-action="telegram"]`)).toBeVisible();
    await expect(page.locator(`a[href="${MAX}"][data-kuzmich-action="max"]`)).toBeVisible();

    // Первая шапка в DOM — фиксированная шапка сайта, вторая — у заголовка.
    const siteHeader = await page.locator('header').first().boundingBox();
    const h1 = await page.locator('h1').boundingBox();
    expect(siteHeader, 'шапка сайта не найдена').not.toBeNull();
    expect(h1, 'заголовок не найден').not.toBeNull();
    expect(h1!.y).toBeGreaterThanOrEqual(siteHeader!.y + siteHeader!.height);
  });
}
