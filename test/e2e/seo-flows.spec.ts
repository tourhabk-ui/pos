/**
 * Метаданные для поиска и три живых действия в шапке.
 *
 * ── Что чинилось 12.09 ────────────────────────────────────────────────────
 *
 * Спека не вызывалась ни одним workflow с 14.08 (#1833). Первый прогон: блок
 * «SEO & Meta» прошёл целиком, «Core User Flows» упал весь. Причины разные, и
 * каждая — отдельный урок.
 *
 * `can navigate from homepage to routes` — `networkidle` после клика. Сеть на
 * наших страницах не затихает (тайлы карты, опрос статуса), ожидание висело до
 * таймаута.
 *
 * `theme toggle works` — селектор `[aria-label*="ема"], …, button:has(svg…)`
 * с `.first()`. Клик перехватывал `<a href="/catalog">Туры</a>` из десктопной
 * навигации: `.first()` выбирал перекрытый элемент. В шапке есть настоящие
 * подписи (`components/layout/Header.tsx`) — спрашиваем по роли и имени, как
 * спрашивает скринридер.
 *
 * `search modal can open` — худший случай. Селектор `button:has(svg)` брал
 * ЛЮБУЮ кнопку с иконкой, а единственное утверждение про модалку стояло под
 * `.catch(() => {})`: провал проверки проглатывался. Тест не мог упасть на
 * том, что проверял, и мог упасть на чём угодно другом.
 *
 * Общее у всех трёх — `if (await X.isVisible())` вокруг тела: не нашли
 * элемент, тест зелёный. Здесь этого больше нет: чего нет — то падение.
 */
import { test, expect } from '@playwright/test';

test.describe('SEO & Meta', () => {
  test('homepage has meta description', async ({ page }) => {
    await page.goto('/');
    const desc = page.locator('meta[name="description"]');
    await expect(desc).toHaveAttribute('content', /.+/);
  });

  test('homepage has og:title', async ({ page }) => {
    await page.goto('/');
    const og = page.locator('meta[property="og:title"]');
    await expect(og).toHaveAttribute('content', /.+/);
  });

  test('robots.txt is accessible', async ({ request }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('Sitemap');
  });

  test('sitemap.xml is accessible', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('urlset');
  });

  test('llms.txt is accessible', async ({ request }) => {
    const res = await request.get('/llms.txt');
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe('Живые действия в шапке', () => {
  test('с главной можно уйти в маршруты', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const link = page.locator('a[href*="/routes"]').first();
    await expect(link, 'с главной нет ни одной ссылки в маршруты').toBeVisible({ timeout: 15_000 });

    await link.click();
    await page.waitForURL(/\/routes/, { timeout: 15_000 });
    expect(page.url()).toMatch(/\/routes/);
  });

  test('поиск открывается модальным окном', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Подпись из Header.tsx: aria-label="Поиск (Ctrl+K)". Поиск в шапке —
    // только иконка, открывающая модалку (решение владельца, §2).
    const searchBtn = page.getByRole('button', { name: /Поиск/i }).first();
    await expect(searchBtn, 'в шапке нет кнопки поиска').toBeVisible({ timeout: 15_000 });

    await searchBtn.click();
    // Утверждение НЕ под catch: раньше провал этой проверки проглатывался.
    await expect(
      page.getByRole('dialog').first(),
      'поиск нажался, а модалка не открылась',
    ).toBeVisible({ timeout: 10_000 });
  });

  test('переключатель темы меняет тему', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Подпись зависит от текущей темы: «Тёмная тема» или «Светлая тема».
    const toggle = page.getByRole('button', { name: /(Тёмная|Светлая) тема/ }).first();
    await expect(toggle, 'в шапке нет переключателя темы').toBeVisible({ timeout: 15_000 });

    const before = await page.locator('html').getAttribute('class');
    await toggle.click();
    await expect
      .poll(() => page.locator('html').getAttribute('class'), {
        message: 'класс html не изменился — тема не переключилась',
        timeout: 5_000,
      })
      .not.toBe(before);
  });
});
