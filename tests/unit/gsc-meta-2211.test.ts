import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLACE_SEARCH_META } from '@/lib/seo/place-search-meta';
import { ROUTE_SEARCH_META } from '@/lib/seo/route-search-meta';
import { FISH_SEARCH_META } from '@/lib/seo/fish-description';

const code = (p: string) => readFileSync(p, 'utf8');
const BRAND = ' | Ведар';

const STATIC = {
  routes: {
    file: 'app/routes/(list)/page.tsx',
    title: 'Маршруты к вулканам Камчатки — сложность и сезон',
    description:
      'Для первой поездки обычно выбирают Авачинский или Горелый: оба близко к городу. Сезон — июль–сентябрь. В каталоге также маршруты к источникам и озёрам.',
  },
  weather: {
    file: 'app/weather/(list)/page.tsx',
    title: 'Погода на Камчатке — 7 дней по местам маршрутов',
    description:
      'Прогноз на 7 дней: Петропавловск, Авачинский, Мутновский, Налычево, Эссо, Ключи. По дням и частям дня — осадки, ветер, предупреждения Росгидромета.',
  },
} as const;

describe('сниппеты под страницы GSC 18–20.11 без кликов', () => {
  it('места: title с брендом ≤ 60, description ≤ 160, без цен', () => {
    for (const [slug, m] of Object.entries(PLACE_SEARCH_META)) {
      expect((m.title + BRAND).length, slug).toBeLessThanOrEqual(60);
      expect(m.description.length, slug).toBeLessThanOrEqual(160);
      for (const s of [m.title, m.description]) expect(s, slug).not.toMatch(/₽|руб/);
    }
  });

  it('Верблюд, Кроноцкое, Терпук и Шлен — точные факты карточки, не шаблон «как добраться»', () => {
    const v = PLACE_SEARCH_META['ekstruziya-verblyud'];
    expect(v.title).toMatch(/Верблюд/);
    expect(v.title).toMatch(/Авачинским и Корякским/);
    expect(v.description).toMatch(/1250 м/);
    expect(v.description).toMatch(/свободного посещения/);
    expect(v.title).toMatch(/между Авачинским и Корякским/);
    expect(v.description).toMatch(/между Авачинским и Корякским/);
    expect(v.leadAnswer?.text).toMatch(/между Авачинским и Корякским/);

    const k = PLACE_SEARCH_META['ozero-kronotskoe'];
    expect(k.title).toMatch(/245 км²/);
    expect(k.description).toMatch(/Долины гейзеров/);
    expect(k.description).toMatch(/разрешен/);
    expect(k.description).not.toMatch(/Где оно на карте/);

    const t = PLACE_SEARCH_META.terpuk;
    expect(t.title).toMatch(/^Вулкан Терпук/);
    expect(t.title).toMatch(/щитовой/);
    expect(t.description).toMatch(/2500–3000/);
    expect(t.description).toMatch(/Седанкинском доле/);
    expect(t.description).not.toMatch(/что о нём известно/);

    const s = PLACE_SEARCH_META.shlen;
    expect(s.title).toMatch(/1018 м/);
    expect(s.description).toMatch(/Правая и Вторая Рассошина/);
    expect(s.title).not.toMatch(/как добраться/i);
  });

  it('маршруты: Мыс Лопатка укладывается в 60 знаков и не зовёт маршрут лёгким', () => {
    const m = ROUTE_SEARCH_META['mys-lopatka'];
    expect((m.title + BRAND).length).toBeLessThanOrEqual(60);
    expect(m.description.length).toBeLessThanOrEqual(160);
    expect(m.title).toMatch(/2,7 км/);
    expect(m.description).toMatch(/импортирована/);
    expect(`${m.title} ${m.description}`).not.toMatch(/лёгк/i);
  });

  it('карточка маршрута берёт точечный сниппет, если он есть', () => {
    const src = code('app/routes/[id]/page.tsx');
    expect(src).toMatch(/routeSearchMeta\(route\.slug\)/);
    expect(src).toMatch(/search\?\.title \?\? fitTitleRequired/);
    expect(src).toMatch(/search\?\.description \?\? \(routeDescription\(/);
  });

  it('форель: без латыни в title, сезон и микижа в описании, длины в пределе', () => {
    const m = FISH_SEARCH_META.forel;
    expect((m.title + BRAND).length).toBeLessThanOrEqual(60);
    expect(m.description.length).toBeLessThanOrEqual(160);
    expect(m.title).toMatch(/микижа/);
    expect(m.title).toMatch(/май — сентябрь/);
    expect(m.title).not.toMatch(/Salmo|mykiss/i);
    expect(m.description).toMatch(/микижу/);
    expect(m.description).toMatch(/май — сентябрь/);
    expect(m.description).toMatch(/6,5 кг/);
    expect(`${m.title} ${m.description}`).not.toMatch(/₽|руб/);
  });

  it('карточка вида берёт точечный сниппет, иначе прежний шаблон', () => {
    const src = code('app/fish/[id]/page.tsx');
    expect(src).toMatch(/fishSearchMeta\(id\)/);
    expect(src).toMatch(/search\?\.title \?\? `\$\{species\.name\} на Камчатке — \$\{species\.nameLatin\}`/);
    expect(src).toMatch(/search\?\.description \?\? fishMetaDescription\(species\)/);
  });

  it('/routes и /weather: title с брендом ≤ 60, description ≤ 160, строки совпадают с кодом', () => {
    for (const [name, row] of Object.entries(STATIC)) {
      expect((row.title + BRAND).length, name).toBeLessThanOrEqual(60);
      expect(row.description.length, name).toBeGreaterThanOrEqual(70);
      expect(row.description.length, name).toBeLessThanOrEqual(160);
      const src = code(row.file);
      expect(src, name).toContain(row.title);
      expect(src, name).toContain(row.description);
    }
    const routesTitle = STATIC.routes.title;
    expect(routesTitle).toMatch(/^Маршруты к вулканам Камчатки/);
    expect(STATIC.routes.description).not.toMatch(/Как выбрать лучший/);
  });
});
