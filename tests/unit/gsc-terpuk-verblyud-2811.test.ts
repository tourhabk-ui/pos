/**
 * Две мелкие правки 28.11 (владелец: «Выполняй»): сниппет Терпука с расстоянием
 * и title Верблюда со словом «экструзия». /routes и разницу во времени не трогаем.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLACE_SEARCH_META } from '@/lib/seo/place-search-meta';

const BRAND = ' | Ведар';

describe('Терпук: описание отвечает «где находится», факты карточки', () => {
  const t = PLACE_SEARCH_META.terpuk;
  it('новое описание: 472 км по прямой к северу, южнее Леутонгея, возраст потоков; без цен; ≤ 160', () => {
    expect(t.description).toBe(
      'Небольшой базальтовый щитовой вулкан в 472 км по прямой к северу от Петропавловска, южнее Леутонгея. Лавовые потоки — 2500–3000 лет назад.',
    );
    expect(t.description.length).toBeLessThanOrEqual(160);
    expect(t.description).not.toMatch(/₽|руб/);
    expect(t.title).toMatch(/^Вулкан Терпук/);
    expect((t.title + BRAND).length).toBeLessThanOrEqual(60);
  });
});

describe('Верблюд: title называет экструзию и два вулкана, в лимите', () => {
  const v = PLACE_SEARCH_META['ekstruziya-verblyud'];
  it('title ≤ 52 знаков до бренда и держит «между Авачинским и Корякским»', () => {
    expect(v.title).toBe('Верблюд: экструзия между Авачинским и Корякским');
    expect(v.title.length).toBeLessThanOrEqual(52);
    expect((v.title + BRAND).length).toBeLessThanOrEqual(60);
    expect(v.title).toMatch(/между Авачинским и Корякским/);
    expect(v.description).toMatch(/между Авачинским и Корякским/);
  });
});

describe('/routes и разница во времени не затронуты', () => {
  it('файлы каталога маршрутов и посадочной не менялись в этом коммите по смыслу теста-сторожа', () => {
    const routes = readFileSync('app/routes/(list)/page.tsx', 'utf8');
    expect(routes).toMatch(/title: 'Маршруты к вулканам Камчатки — сложность и сезон'/);
    // Слово «лучшие» только в комментарии про запрос GSC, в title/description его нет.
    const meta = routes.slice(routes.indexOf('const BASE_METADATA'), routes.indexOf('interface PageProps'));
    expect(meta).not.toMatch(/лучшие/);
    const landing = readFileSync('app/raznica-vo-vremeni-kamchatka-moskva/page.tsx', 'utf8');
    expect(landing).toMatch(/landingBySlug\(SLUG\)/);
  });
});
