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
import { publicExternalHref } from '@/lib/seo/public-external-href';
import { PUBLIC_NAP } from '@/lib/legal/requisites';

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

  it('пользовательские ссылки на KVERT сняты: https у сайта не открывается', () => {
    expect(publicExternalHref('http://kvert.febras.net/')).toBeUndefined();
    expect(publicExternalHref('http://kvert.febras.net/color.php')).toBeUndefined();
    expect(publicExternalHref('https://visitkamchatka.ru/security/')).toBe('https://visitkamchatka.ru/security/');
    const safety = read('lib/seo/safety-page.ts');
    expect(safety).toContain("label: 'KVERT, Институт вулканологии и сейсмологии ДВО РАН'");
    expect(safety).not.toMatch(/href: KVERT_/);
    expect(read('lib/seo/routes-volcano-lead.ts')).not.toContain('kvert.febras.net');
    // Серверная лента по-прежнему ходит по HTTP.
    expect(read('lib/agents/kvert-sync.ts')).toContain("const DEFAULT_KVERT_URL = 'http://kvert.febras.net/van/index.php?type=3&lend=en'");
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

describe('Seodar 27.11: публичный NAP без улицы', () => {
  it('/contact, /about, подвал и Organization показывают только город и край', () => {
    expect(PUBLIC_NAP.line).toBe('683024, Камчатский край, г. Петропавловск-Камчатский');
    expect(PUBLIC_NAP.line).not.toMatch(/Октября|17\/1|street/i);
    for (const f of ['app/contact/page.tsx', 'app/about/page.tsx', 'components/layout/Footer.tsx', 'app/layout.tsx']) {
      const src = read(f);
      expect(src, f).toContain('PUBLIC_NAP');
      expect(src, f).not.toContain('17/1');
      expect(src, f).not.toContain('streetAddress');
    }
  });
});

describe('Seodar 27.11: обложка тура на посадочной без героя', () => {
  it('первая обложка — eager, список мест и нижнее меню остаются lazy', () => {
    const src = read('components/landings/LandingContent.tsx');
    expect(src).toContain('eager={firstCoverId === t.id}');
    expect(src).toContain("tours.find((t) => tourCover(t))?.id");
    expect(read('components/places/PlaceNearby.tsx')).toContain('loading="lazy"');
    expect(read('components/places/PlaceNearby.tsx')).not.toContain('priority: true');
    const nav = read('components/shared/BottomNav.tsx');
    const bearAt = nav.indexOf('src="/images/brand/bear-64.webp"');
    expect(nav.slice(bearAt, bearAt + 500)).toContain('loading="lazy"');
  });
});
