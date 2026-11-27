/**
 * Технические правки по скану Seodar 27.11: битые внешние ссылки,
 * смешанный контент, подписи полей, ориентиры и иерархия заголовков.
 * Без новых URL и без переписывания текстов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { METEOALERT_PAGE } from '@/lib/services/safety/meteoalert';
import { PARK_PERMIT_CHANNELS, VOLCANOES_DECREE_DOC } from '@/lib/safety/park-permit';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf-8');

describe('Seodar 27.11: внешние ссылки', () => {
  it('предупреждения Гидрометцентра ведут на действующий бюллетень, а не на 404', () => {
    expect(METEOALERT_PAGE).toBe('https://meteoinfo.ru/hazardsbull');
    expect(METEOALERT_PAGE).not.toContain('/warnings');
  });

  it('постановление о нацпарке «Вулканы Камчатки» — по https', () => {
    expect(VOLCANOES_DECREE_DOC.url).toBe('https://government.ru/docs/all/166655/');
  });

  it('у канала Госуслуги41 нет битой ссылки на volcano_info.htm', () => {
    const gosuslugi = PARK_PERMIT_CHANNELS.find((c) => c.key === 'gosuslugi');
    expect(gosuslugi).toBeTruthy();
    expect(gosuslugi?.href).toBeUndefined();
    expect(gosuslugi?.detail).toMatch(/gosuslugi41\.ru/);
    expect(read('lib/safety/park-permit.ts')).not.toContain('volcano_info.htm');
  });

  it('официальный сайт KVERT остаётся http: https у него не открывается', () => {
    const safety = read('lib/seo/safety-page.ts');
    expect(safety).toContain("const KVERT_URL = 'http://kvert.febras.net/'");
    expect(safety).toContain("const KVERT_COLORS_URL = 'http://kvert.febras.net/color.php'");
    const lead = read('lib/seo/routes-volcano-lead.ts');
    expect(lead).toContain("href: 'http://kvert.febras.net/volc?lang=ru&name=Avachinsky'");
    expect(lead).not.toContain('https://kvert.febras.net/');
  });
});

describe('Seodar 27.11: доступность и ориентиры', () => {
  it('список ситуации на /sos связан с подписью через id и htmlFor', () => {
    const src = read('components/safety/SatelliteDictationCard.tsx');
    expect(src).toContain('htmlFor="sos-situation"');
    expect(src).toContain('id="sos-situation"');
    expect(src).toContain('htmlFor="sos-count"');
    expect(src).toContain('id="sos-count"');
  });

  it('кнопка отправки у Кузьмича имеет доступное имя', () => {
    const src = read('app/kuzmich/_KuzmichClient.tsx');
    expect(src).toContain('aria-label="Отправить"');
    expect(src).toContain("aria-label={preparingImage ? 'Готовим фото' : 'Прикрепить фото'}");
  });

  it('у /places, /routes, /safety, /sos и /map есть <main>', () => {
    expect(read('app/routes/_RoutesPageClient.tsx')).toMatch(/<main className="ds-page pt-20 pb-10">/);
    expect(read('app/safety/page.tsx')).toMatch(/<main className="ds-page px-4"/);
    expect(read('app/sos/page.tsx')).toMatch(/<main style=\{\{/);
    expect(read('app/map/_MapPageClient.tsx')).toContain('<main>');
    expect(read('app/map/_MapPageClient.tsx')).toContain('aria-label="Ведар — на главную"');
  });

  it('карточки мест и маршрутов в каталоге идут h1 → h2, у снимков есть width и height', () => {
    const place = read('components/routes/PlaceCard.tsx');
    expect(place).toMatch(/<h2\n\s+className="line-clamp-2 font-semibold/);
    expect(place).not.toMatch(/<h3\n\s+className="line-clamp-2 font-semibold/);
    expect(place).toContain('width={800}');
    expect(place).toContain('height={600}');
    const route = read('components/routes/RoutePathCard.tsx');
    expect(route).toMatch(/<h2\n\s+className="font-semibold text-\[var\(--text-primary\)\]/);
    expect(route).toContain('width={800}');
    expect(route).toContain('height={500}');
    const hero = read('components/homepage/desk/DeskHero.tsx');
    expect(hero).toContain('width={2400}');
    expect(hero).toContain('height={1600}');
  });
});
