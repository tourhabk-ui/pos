/**
 * Подпись «Фото:» называет и авторов галереи (04.10).
 *
 * Козельский: герой — кадр владельца платформы, в галерею лёг кадр Ильи
 * Оноприйчука (миграция 1162). Подпись читала только автора героя, и чужой
 * кадр выходил под чужим именем — это утверждение о правах, а не мелочь.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { photoAttributionOf } from '@/lib/places/place-detail';

describe('photoAttributionOf', () => {
  it('герой и галерея разных авторов — оба в подписи, герой не повторяется', () => {
    const a = photoAttributionOf({
      photo_author: 'владелец платформы',
      gallery_authors: ['владелец платформы', 'Илья Оноприйчук'],
    });
    expect(a?.author).toBe('владелец платформы');
    expect(a?.otherAuthors).toEqual(['Илья Оноприйчук']);
  });

  it('у героя автора нет, у галереи есть — подпись есть', () => {
    const a = photoAttributionOf({ photo_author: null, gallery_authors: ['Илья Оноприйчук'] });
    expect(a).not.toBeNull();
    expect(a?.author).toBeNull();
    expect(a?.otherAuthors).toEqual(['Илья Оноприйчук']);
  });

  it('никого не знаем — подписи нет, а не выдуманное имя', () => {
    expect(photoAttributionOf({ photo_author: null, photo_license: null, gallery_authors: [] })).toBeNull();
    expect(photoAttributionOf({})).toBeNull();
  });

  it('карточка печатает авторов галереи', () => {
    const src = readFileSync(join(process.cwd(), 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf8');
    expect(src).toContain("place.photoAttribution.otherAuthors.join(', ')");
  });

  it('кадр Ильи лёг в галерею с его именем, а героя владельца не трогает', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/1162_kozelsky_onopriychuk_photo.sql'), 'utf8');
    expect(sql).toContain("'Илья Оноприйчук'");
    expect(sql).not.toMatch(/INSERT INTO ai_route_images/);
    expect(sql).toContain('WHERE place_gallery_photos.caption = EXCLUDED.caption');
  });
});
