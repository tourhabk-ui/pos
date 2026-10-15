/**
 * Подпись кадра галереи на карточке места — автор, лицензия и страница файла,
 * как у главного кадра (15.10).
 *
 * До этого дня кадр галереи подписывался одним именем. Для снимка Wikimedia
 * Commons это неполная атрибуция (CC BY и CC BY-SA требуют лицензию и
 * ссылку), а после 1263/1265/1266 у трёх карточек Налычева снимки Commons
 * живут только в галерее. Судится вызовом и рендером: что человек видит под
 * кадром и куда ведут ссылки.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PhotoCredit, { creditFor } from '@/components/places/PhotoCredit';
import { photoCreditsOf, photoRightsOf } from '@/lib/places/place-detail';

afterEach(cleanup);

const ARK = 'c7c9f572-5e78-4d4f-a9ee-d0182eb313d6';
const G1 = `/api/images/place-gallery/${ARK}/1?v=1`;
const G2 = `/api/images/place-gallery/${ARK}/2?v=2`;
const G3 = `/api/images/place-gallery/${ARK}/3?v=3`;
const HERO = `/api/images/route/${ARK}?v=9`;
const SOURCE = 'https://commons.wikimedia.org/wiki/File:Nalychevo.jpg';
const BY_SA = 'https://creativecommons.org/licenses/by-sa/4.0';
const isHero = (s: string) => s.startsWith('/api/images/route/');

/** Строка загрузчика: герой спрятан (photo_count 0), в галерее — Commons, владелец и общественное достояние. */
const ROW = {
  ark_id: ARK,
  photo_count: 0,
  gallery_urls: [G1, G2, G3],
  gallery_authors: ['Rost.galis', 'владелец платформы', 'Gistereziz'],
  gallery_rights: [
    { license: 'CC BY-SA 4.0', license_url: BY_SA, source_url: 'https://commons.wikimedia.org/wiki/File:A.jpg' },
    { license: null, license_url: null, source_url: null },
    { license: 'Общественное достояние', license_url: null, source_url: SOURCE },
  ],
};

describe('права кадра галереи из загрузчика', () => {
  it('у кадра Commons — лицензия и страница файла; у кадра владельца записи нет, лицензия не выдумывается', () => {
    const rights = photoRightsOf(ROW);
    expect(rights[G1]).toEqual({ license: 'CC BY-SA 4.0', licenseUrl: BY_SA, sourceUrl: 'https://commons.wikimedia.org/wiki/File:A.jpg' });
    expect(G2 in rights).toBe(false);
    expect(rights[G3]).toEqual({ license: 'Общественное достояние', licenseUrl: null, sourceUrl: SOURCE });
  });

  it('права идут тем же порядком и теми же строками, что адреса кадров', () => {
    const sql = readFileSync(join(process.cwd(), 'lib/places/place-detail.ts'), 'utf8');
    const block = sql.slice(sql.indexOf('AS gallery_authors'), sql.indexOf('AS gallery_rights'));
    expect(block).toMatch(/\) ORDER BY g\.position\), '\[\]'::json\)/);
    expect(block).toMatch(/WHERE g\.ark_id = p\.ark_id AND g\.hidden_reason IS NULL\)\s*$/);
  });
});

describe('подпись под кадром на экране', () => {
  const credits = photoCreditsOf(ROW);
  const rights = photoRightsOf(ROW);
  const hero = { author: 'Автор героя', license: 'CC BY 2.0', licenseUrl: null, sourceUrl: null };

  it('кадр Commons: «Фото: автор · лицензия», имя ведёт на страницу файла, лицензия — на её текст', () => {
    render(<PhotoCredit {...creditFor(G1, credits, rights, hero, isHero)!} />);
    expect(document.body.textContent).toBe('Фото: Rost.galis · CC BY-SA 4.0');
    expect(screen.getByRole('link', { name: 'Rost.galis' }).getAttribute('href')).toBe('https://commons.wikimedia.org/wiki/File:A.jpg');
    expect(screen.getByRole('link', { name: 'CC BY-SA 4.0' }).getAttribute('href')).toBe(BY_SA);
  });

  it('кадр владельца: только имя, без ссылок и без чужой лицензии героя', () => {
    render(<PhotoCredit {...creditFor(G2, credits, rights, hero, isHero)!} />);
    expect(document.body.textContent).toBe('Фото: владелец платформы');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('общественное достояние: имя со ссылкой на файл, лицензия словами', () => {
    render(<PhotoCredit {...creditFor(G3, credits, rights, hero, isHero)!} />);
    expect(document.body.textContent).toBe('Фото: Gistereziz · Общественное достояние');
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([SOURCE]);
  });

  it('главный кадр и «кадр ещё не известен» — подпись героя; офлайн-кэш без прав — одно имя', () => {
    expect(creditFor(HERO, { ...credits, [HERO]: 'Автор героя' }, rights, hero, isHero)).toBe(hero);
    expect(creditFor(null, credits, rights, hero, isHero)).toBe(hero);
    expect(creditFor(G1, credits, undefined, hero, isHero)).toEqual({ author: 'Rost.galis', license: null, licenseUrl: null, sourceUrl: null });
  });

  it('кадр галереи без автора и прав — подписи нет, имя героя ему не приписывается', () => {
    const anon = `/api/images/place-gallery/${ARK}/4?v=4`;
    expect(creditFor(anon, { ...credits, [anon]: null }, rights, hero, isHero)).toBeNull();
    expect(creditFor(null, credits, rights, null, isHero)).toBeNull();
  });

  it('ни автора, ни лицензии — подписи нет', () => {
    const { container } = render(<PhotoCredit author={null} license={null} licenseUrl={null} sourceUrl="https://x.test" />);
    expect(container.textContent).toBe('');
  });
});
