/**
 * Сниппеты под выгрузку GSC 18–21.11: прямые ответы на существующих страницах,
 * без новых адресов и без выдуманных фактов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLACE_SEARCH_META } from '@/lib/seo/place-search-meta';
import { FISH_BY_ID, FISH_SPECIES } from '@/lib/fish-species';
import { FISH_SEARCH_META } from '@/lib/seo/fish-description';
import {
  FISH_SECTIONS,
  FISH_SOURCES,
  FISH_TEXT_LINKS,
  FISH_PAGE_DATE,
} from '@/lib/seo/fish-page';
import {
  ROUTES_VOLCANO_LEAD,
  ROUTES_VOLCANO_MORE,
  ROUTES_VOLCANO_SOURCES,
} from '@/lib/seo/routes-volcano-lead';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf-8');
const BRAND = ' | Ведар';

describe('/routes: ответ для первой поездки', () => {
  it('называет Авачинский и Горелый, высоты KVERT, не пишет «лучшие» и цены', () => {
    expect(ROUTES_VOLCANO_LEAD).toMatch(/Авачинский вулкан \(2751 м по KVERT\)/);
    expect(ROUTES_VOLCANO_LEAD).toMatch(/Горелый \(1828 м\)/);
    expect(ROUTES_VOLCANO_LEAD).toMatch(/Петропавловску-Камчатскому/);
    expect(ROUTES_VOLCANO_LEAD).toMatch(/июль–сентябрь/);
    expect(ROUTES_VOLCANO_LEAD).toMatch(/Мутновскому/);
    expect(ROUTES_VOLCANO_LEAD).not.toMatch(/лучш/i);
    expect(ROUTES_VOLCANO_LEAD).not.toMatch(/₽|руб/);
    expect(ROUTES_VOLCANO_MORE.href).toBe('/voshozhdeniya-na-vulkany-kamchatki');
  });

  it('источники — KVERT, Visit Kamchatka и сводка «Кам 24»', () => {
    const hrefs = ROUTES_VOLCANO_SOURCES.map((s) => s.href).join(' ');
    expect(hrefs).toMatch(/kvert\.febras\.net\/volc\?lang=ru&name=Avachinsky/);
    expect(hrefs).toMatch(/kvert\.febras\.net\/volc\?lang=ru&name=Gorely/);
    expect(hrefs).toMatch(/visitkamchatka\.ru\/activities\/voskhozhdeniya/);
    expect(hrefs).toMatch(/kam24\.ru\/news\/main\/20261112\/134130/);
  });

  it('лид рисуется в серверном HTML клиента только для вкладки маршрутов', () => {
    const src = read('app/routes/_RoutesPageClient.tsx');
    expect(src).toMatch(/kind === 'route'/);
    expect(src).toContain('ROUTES_VOLCANO_LEAD');
    expect(src).toContain('data-lead-answer');
  });
});

describe('Верблюд и вулкан Терпук', () => {
  it('сниппет Верблюда держит формулу «между Авачинским и Корякским»', () => {
    const v = PLACE_SEARCH_META['ekstruziya-verblyud'];
    expect(v.title).toMatch(/между Авачинским и Корякским/);
    expect(v.description).toMatch(/между Авачинским и Корякским/);
    expect(v.leadAnswer?.text).toMatch(/между Авачинским и Корякским/);
    expect((v.title + BRAND).length).toBeLessThanOrEqual(60);
    expect(v.description.length).toBeLessThanOrEqual(160);
  });

  it('title места Терпук явно говорит «Вулкан Терпук»', () => {
    const t = PLACE_SEARCH_META.terpuk;
    expect(t.title).toMatch(/^Вулкан Терпук/);
    expect((t.title + BRAND).length).toBeLessThanOrEqual(60);
    expect(t.description.length).toBeLessThanOrEqual(160);
  });
});

describe('чавыча: царь лососей', () => {
  it('прямой ответ называет царя лососей и даёт источники', () => {
    const a = FISH_BY_ID.chavycha.leadAnswer;
    expect(a?.text).toMatch(/царём лососей/);
    expect(a?.text).toMatch(/царём-рыбой/);
    expect(a?.text).toMatch(/королевским лососем/);
    expect(a?.source.url).toMatch(/fisheries\.noaa\.gov/);
    expect(a?.moreSources?.some((s) => s.url.includes('fishnews.ru'))).toBe(true);
    expect(a?.moreSources?.some((s) => s.url.includes('visitkamchatka.ru'))).toBe(true);
  });

  it('сниппет вида укладывается в пределы и не открывает новый адрес', () => {
    const m = FISH_SEARCH_META.chavycha;
    expect((m.title + BRAND).length).toBeLessThanOrEqual(60);
    expect(m.description.length).toBeLessThanOrEqual(160);
    expect(m.title).toMatch(/царь лососей/);
    expect(FISH_SPECIES.some((s) => s.id === 'chavycha')).toBe(true);
  });
});

describe('/fish: терпуг на существующей странице, без /fish/terpuk', () => {
  it('раздел о видах называет терпуга и отличает его от вулкана', () => {
    const first = FISH_SECTIONS.find((s) => s.id === 'kakuyu-rybu');
    const text = first?.paragraphs.join(' ') ?? '';
    expect(text).toMatch(/терпуга/);
    expect(text).toMatch(/щитовым вулканом Терпук/);
    expect(text).toMatch(/Авачинской бухты/);
    expect(FISH_PAGE_DATE).toBe('2026-11-27');
  });

  it('есть источники и ссылка на /places/terpuk, нового вида в справочнике нет', () => {
    expect(FISH_SOURCES.some((s) => s.href === 'https://visitkamchatka.ru/national-route/')).toBe(true);
    expect(FISH_SOURCES.some((s) => s.href.includes('rybak-kamchatky.ru/news/5355'))).toBe(true);
    expect(FISH_TEXT_LINKS.some((l) => l.href === '/places/terpuk' && l.text === 'щитовым вулканом Терпук')).toBe(true);
    expect(FISH_SPECIES.some((s) => s.id === 'terpuk')).toBe(false);
  });
});
