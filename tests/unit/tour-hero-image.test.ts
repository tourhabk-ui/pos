/**
 * Сторож главного кадра тура (29.09): главная и каталог показывают тот же
 * кадр, что и карточка тура, — первый кадр галереи, а не `tour_image`.
 *
 * Повод — владелец: «на главной в турах сезона теряется красивая картинка».
 * У сплава по Быстрой `tour_image` — групповое фото, а первым кадром галереи
 * стоит река на фоне вулканов; главная брала первое, карточка — второе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tourHeroImage, tourHeroImageSql } from '@/lib/tours/hero-image';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('главный кадр тура', () => {
  it('галерея впереди обложки', () => {
    expect(tourHeroImage(['/g/1.jpg', '/g/2.jpg'], '/cover.jpg')).toBe('/g/1.jpg');
  });

  it('нет галереи — обложка; пустая строка и пробелы — не кадр', () => {
    expect(tourHeroImage(null, '/cover.jpg')).toBe('/cover.jpg');
    expect(tourHeroImage([], '/cover.jpg')).toBe('/cover.jpg');
    expect(tourHeroImage(['  '], '/cover.jpg')).toBe('/cover.jpg');
  });

  it('ни галереи, ни обложки — null, а не выдумка', () => {
    expect(tourHeroImage(null, null)).toBeNull();
    expect(tourHeroImage([''], '  ')).toBeNull();
    expect(tourHeroImage(undefined, undefined)).toBeNull();
  });

  it('SQL называет тот же порядок: галерея, затем обложка', () => {
    const sql = tourHeroImageSql('t');
    expect(sql.indexOf('(t.photos)[1]')).toBeGreaterThan(-1);
    expect(sql.indexOf('(t.photos)[1]')).toBeLessThan(sql.indexOf('t.tour_image'));
  });

  it('главная, каталог и метаданные страницы берут кадр из общего правила', () => {
    expect(code('app/_home/data.ts')).toMatch(/tourHeroImageSql\('ot'\)[^\n]*AS image_url/);
    expect(code('lib/search/tour-search.ts')).toMatch(/tourHeroImageSql\('ot'\)\} AS tour_image/);
    expect(code('app/catalog/tours/[id]/page.tsx')).toMatch(/tourHeroImage\(tour\.photos, tour\.tour_image\)/);
  });

  it('своей копии «обложка раньше галереи» на главной не осталось', () => {
    expect(code('app/_home/data.ts')).not.toMatch(/COALESCE\(ot\.tour_image,\s*\(ot\.photos\)\[1\]\)/);
  });
});
