/**
 * Вес SEO-находки по трафику из выгрузки Search Console (слово владельца 27.11
 * «1 вариант по seo», scripts/seo/gsc-weigh.mjs).
 *
 * Выгрузка здесь синтетическая: настоящая содержит запросы людей и в
 * репозиторий не кладётся. Судится поведение — разбор настоящего формата
 * выгрузки (BOM, кавычки, «1.25%», русские и английские имена файлов),
 * ожидаемый CTR из данных самого сайта, «не известно» вместо нуля и порядок
 * находок.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error — скрипт на чистом JS без деклараций типов
import * as gsc from '../../scripts/seo/gsc-weigh.mjs';

const PAGES_RU =
  '﻿Популярные страницы,Kлики,Показы,CTR,Позиция\n' +
  'https://vedarai.ru/flights,0,250,0%,8.8\n' +
  'https://vedarai.ru/fish,2,300,0.67%,6.9\n' +
  'https://vedarai.ru/places/a,10,400,2.5%,6.1\n' +
  'https://vedarai.ru/places/b,6,700,0.86%,9.2\n' +
  'https://vedarai.ru/routes/1b4e28ba-2fa1-11d2-883f-0016d3cca427,0,20,0%,12\n' +
  'https://vedarai.ru/top,3,40,7.5%,1.5\n';
const QUERIES_RU = 'Популярные запросы,Kлики,Показы,CTR,Позиция\n"рыбалка, камчатка",1,30,3.33%,7\n';
const CHART_RU = 'Дата,Kлики,Показы,CTR,Позиция\n2026-11-18,10,800,1.25%,8\n2026-11-24,11,910,1.21%,7.9\n';

let dir: string;
let dirEn: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gsc-ru-'));
  writeFileSync(join(dir, 'Страницы.csv'), PAGES_RU);
  writeFileSync(join(dir, 'Запросы.csv'), QUERIES_RU);
  writeFileSync(join(dir, 'Диаграмма.csv'), CHART_RU);
  dirEn = mkdtempSync(join(tmpdir(), 'gsc-en-'));
  writeFileSync(join(dirEn, 'Pages.csv'), PAGES_RU.replace('Популярные страницы', 'Top pages'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirEn, { recursive: true, force: true });
});

describe('разбор выгрузки', () => {
  it('BOM, проценты и запятая в кавычках', () => {
    expect(gsc.parseCsv(QUERIES_RU)[1][0]).toBe('рыбалка, камчатка');
    expect(gsc.toNumber('1.25%')).toBe(1.25);
    expect(gsc.toNumber('8,6')).toBe(8.6);
    expect(gsc.toNumber('')).toBeNull();
    expect(gsc.tableRows(PAGES_RU)[0]).toEqual({ key: 'https://vedarai.ru/flights', clicks: 0, impressions: 250, position: 8.8 });
  });

  it('русские и английские имена файлов; чего нет — названо', () => {
    const ru = gsc.readExport(dir);
    expect(ru.pages).toHaveLength(6);
    expect(ru.missing).toEqual([]);
    const en = gsc.readExport(dirEn);
    expect(en.pages).toHaveLength(6);
    expect(en.missing).toEqual(['queries', 'chart']);
  });
});

describe('ожидаемый CTR — из данных самого сайта', () => {
  it('полоса 5–7 и 8–10 считаются; полоса с малым числом показов — не известно', () => {
    const b = gsc.siteCtrByBucket(gsc.tableRows(PAGES_RU));
    // 5–7: fish 2/300 + places/a 10/400 = 12/700.
    expect(b.get('5-7').ctr).toBeCloseTo(12 / 700, 6);
    // 8–10: flights 0/250 + places/b 6/700 = 6/950.
    expect(b.get('8-10').ctr).toBeCloseTo(6 / 950, 6);
    // 1–2: 40 показов — меньше порога, CTR не известен, а не 7.5%.
    expect(b.get('1-2').ctr).toBeNull();
  });

  it('шаблоны адресов узнают UUID', () => {
    expect(gsc.urlTemplate('https://vedarai.ru/routes/1b4e28ba-2fa1-11d2-883f-0016d3cca427')).toBe('/routes/[uuid]');
    expect(gsc.urlTemplate('https://vedarai.ru/places/ozero-kronotskoe?x=1')).toBe('/places/[slug]');
    expect(gsc.urlTemplate('https://vedarai.ru/')).toBe('/');
  });
});

describe('вес', () => {
  it('недобор кликов: показы × CTR полосы − клики, крупный — первым; мало показов — не ранжируется', () => {
    const w = gsc.weighPages(gsc.tableRows(PAGES_RU));
    // fish: 300 × 12/700 − 2 ≈ 3,14; flights: 250 × 6/950 − 0 ≈ 1,58.
    expect(w[0].url).toBe('https://vedarai.ru/fish');
    expect(w[0].missedClicks).toBeCloseTo(300 * (12 / 700) - 2, 6);
    expect(w[1].url).toBe('https://vedarai.ru/flights');
    expect(w[1].missedClicks).toBeCloseTo(250 * (6 / 950), 6);
    // UUID-адрес с 20 показами — ниже порога страницы, в список не попадает.
    expect(w.map((x: { url: string }) => x.url)).not.toContain('https://vedarai.ru/routes/1b4e28ba-2fa1-11d2-883f-0016d3cca427');
    // Страница в полосе без CTR — недобор не известен, а не ноль.
    expect(w.find((x: { url: string }) => x.url.endsWith('/top')).missedClicks).toBeNull();
  });

  it('находки: вес по адресу, адреса нет — вес не известен и в конце', () => {
    const out = gsc.weighFindings([
      { url: 'https://vedarai.ru/nowhere', issue: 'нет title' },
      { url: 'vedarai.ru/places/b/', issue: 'длинный title' },
      { url: 'https://vedarai.ru/flights', issue: 'нет description' },
    ], gsc.tableRows(PAGES_RU));
    expect(out.map((f: { issue: string }) => f.issue)).toEqual(['нет description', 'длинный title', 'нет title']);
    expect(out[2].weight).toBeNull();
    expect(out[2].weight_note).toMatch(/не известен/);
    // Адрес сравнивается без схемы и хвостовой косой.
    expect(out[1].weight.impressions).toBe(700);
  });

  it('отчёт говорит о малом числе кликов и не выдаёт его за трафик', () => {
    const text = gsc.report(gsc.readExport(dir)).join('\n');
    expect(text).toMatch(/Кликов за период меньше 100/);
    expect(text).toMatch(/1-2: 3\/40 показов, 1 стр\. — не известно/);
  });

  it('скрипт из командной строки: отчёт и вес находок', () => {
    const out = execFileSync('node', ['scripts/seo/gsc-weigh.mjs', dir], { encoding: 'utf8' });
    expect(out).toMatch(/Недобор кликов/);
    const f = join(dir, 'findings.json');
    writeFileSync(f, JSON.stringify([{ url: 'https://vedarai.ru/fish', issue: 'x' }]));
    const json = JSON.parse(execFileSync('node', ['scripts/seo/gsc-weigh.mjs', dir, '--findings', f], { encoding: 'utf8' }));
    expect(json[0].weight.impressions).toBe(300);
  });
});
