/**
 * Подпись под фото — автор ТОГО кадра, что на экране (04.10).
 *
 * Владелец: «"Фото: владелец платформы, Илья Оноприйчук" нужно только под
 * фотографией выводить: если фото Ильи — то и подпись его, если моя —
 * владелец платформы». Первая правка того же дня перечисляла всех авторов
 * разом; это тоже неправда о конкретном кадре.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { photoAttributionOf, photoCreditsOf } from '@/lib/places/place-detail';
import { toWaypointPhotos } from '@/lib/routes/waypoint-photos';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const ARK = '7190e0a4-52f1-47fb-ba17-0fcb493d99df';

describe('место: автор у каждого кадра свой', () => {
  const row = {
    ark_id: ARK, photo_count: 1, photo_version: 100, photo_author: 'владелец платформы',
    gallery_urls: [`/api/images/place-gallery/${ARK}/1?v=1`, `/api/images/place-gallery/${ARK}/2?v=2`, `/api/images/place-gallery/${ARK}/3?v=3`],
    gallery_authors: ['владелец платформы', 'Илья Оноприйчук', null],
  };

  it('кадр Ильи — его имя, кадр владельца — владелец, кадр без автора — никто', () => {
    const c = photoCreditsOf(row);
    expect(c[`/api/images/route/${ARK}?v=100`]).toBe('владелец платформы');
    expect(c[`/api/images/place-gallery/${ARK}/1?v=1`]).toBe('владелец платформы');
    expect(c[`/api/images/place-gallery/${ARK}/2?v=2`]).toBe('Илья Оноприйчук');
    expect(c[`/api/images/place-gallery/${ARK}/3?v=3`]).toBeNull();
  });

  it('ключи совпадают с адресами, которыми карточка отдаёт кадры', () => {
    const src = read('lib/places/place-detail.ts');
    expect(src).toContain("`/api/images/route/${r.ark_id}${v}`");
    expect(src).toMatch(/json_agg\(NULLIF\(btrim\(g\.author\), ''\) ORDER BY g\.position\)/);
    expect(src).toMatch(/'\/api\/images\/place-gallery\/' \|\| g\.ark_id[\s\S]{0,120}ORDER BY g\.position/);
  });

  it('героя подписывает только его автор, без перечня галереи', () => {
    expect(photoAttributionOf({ photo_author: 'владелец платформы', gallery_authors: ['Илья Оноприйчук'] }))
      .toEqual({ author: 'владелец платформы', license: null, licenseUrl: null, sourceUrl: null });
    expect(photoAttributionOf({})).toBeNull();
  });

  it('карточка берёт подпись по кадру на экране, а не списком', () => {
    const page = read('app/places/[id]/_PlaceDetailClient.tsx');
    expect(page).toContain('onCurrentChange={setCurrentPhoto}');
    expect(page).toContain('place.photoCredits[currentPhoto]');
    expect(page).not.toContain('otherAuthors');
    expect(read('components/places/PlaceHero.tsx')).toContain('onCurrentChange?.(currentSrc)');
  });
});

describe('маршрут без своих кадров: фото точки пути с её автором', () => {
  it('автор и место — у каждого кадра, тем же порядком', () => {
    const w = toWaypointPhotos([
      { url: '/a', author: 'владелец платформы', place_name: 'Козельский' },
      { url: '/b', author: 'Илья Оноприйчук', place_name: 'Козельский' },
      { url: '/b', author: 'дубль', place_name: 'Козельский' },
      { url: '/c', author: null, place_name: 'Козельский' },
    ]);
    expect(w.urls).toEqual(['/a', '/b', '/c']);
    expect(w.authors).toEqual(['владелец платформы', 'Илья Оноприйчук', null]);
  });

  it('связь «рядом» кадров маршруту не даёт, генерации не показываются', () => {
    const sql = read('lib/routes/waypoint-photos.ts');
    expect(sql).toContain("<> 'nearby'");
    expect(sql).toContain("shownPhotoSql('ai.model')");
  });

  it('карточка маршрута подписывает кадр точки его автором', () => {
    const card = read('app/routes/[id]/_RouteDetailClient.tsx');
    expect(card).toContain('wpPhotos.authors[i]');
    expect(card).toContain('Фото места «${place}»');
    expect(read('app/api/routes/[id]/route.ts')).toContain("logQueryFailure('waypoint_photos', err, id)");
  });
});

describe('кадр Ильи на Козельском', () => {
  it('лёг в галерею с его именем, героя владельца не трогает', () => {
    const sql = read('migrations/1162_kozelsky_onopriychuk_photo.sql');
    expect(sql).toContain("'Илья Оноприйчук'");
    expect(sql).not.toMatch(/INSERT INTO ai_route_images/);
    expect(sql).toContain('WHERE place_gallery_photos.caption = EXCLUDED.caption');
  });
});
