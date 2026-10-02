/**
 * Статьи «Камчатского лексикона» не выдаются за маршруты (аудит 02.10).
 *
 * 26 статей лежали под двумя адресами: /articles/zima и /routes/kl-zima —
 * один текст, у второго заголовок «— маршрут на Камчатке» и разметка
 * TouristTrip. Оба были в sitemap и canonical на себя. Сторож держит связку:
 * карточка маршрута отвечает 308 на статью, sitemap такой адрес не предлагает.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/routes/[id]/page.tsx', 'utf-8');
const sitemap = readFileSync('lib/seo/sitemap-entries.ts', 'utf-8');

describe('статья-двойник маршрута kl-*', () => {
  it('карточка маршрута ищет статью по slug без префикса kl- и отвечает 308', () => {
    expect(page).toMatch(/async function findArticleTwin\(slug: string\)/);
    expect(page).toMatch(/slug\.startsWith\('kl-'\)/);
    expect(page).toMatch(/FROM articles WHERE slug = \$1 AND is_visible = TRUE/);
    expect(page).toMatch(/permanentRedirect\(`\/articles\/\$\{articleTwin\}`\)/);
  });

  it('отказ проверки не глушится: имя проверки и SQLSTATE уходят в лог', () => {
    const i = page.indexOf('async function findArticleTwin');
    const body = page.slice(i, page.indexOf('\n}\n', i));
    expect(body).toMatch(/console\.error\('\[routes\/\[id\]\] проверка статьи-двойника упала'/);
    expect(body).toMatch(/sqlstate: e\?\.code/);
  });

  it('sitemap не предлагает адрес с редиректом', () => {
    expect(sitemap).toMatch(/NOT EXISTS \(SELECT 1 FROM articles ta WHERE ta\.is_visible = TRUE AND kr\.slug = 'kl-' \|\| ta\.slug\)/);
  });
});
