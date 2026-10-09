/**
 * Сторож: клипы туров в хранилище (решение владельца 09.10: «нарежь короткие
 * видео для туров камчатской рыбалки, без звука, и сохрани их в S3»).
 *
 * - в базе — ключи под videos/, адрес собирает сервер; чужой ключ отбрасывается;
 * - клипы без звуковой дорожки, лежат в media/s3/ и перечислены в маркере заливки;
 * - заливка: файл только из media/s3/, ключ только под videos/, отказ строки —
 *   ничего не залито;
 * - зимним турам клипы с открытой водой не ставятся;
 * - CSP пускает видео из хранилища, иначе клип не заиграет;
 * - клиент не тянет S3-клиент в бандл: из модуля клипов — только тип.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTourClips, MAX_TOUR_CLIPS } from '@/lib/tours/tour-clips';
import { checkItem, MARKER } from '../../scripts/media-to-s3';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const BASE = 'https://s3.twcstorage.ru/bucket';
const clip = (key: string, poster = key.replace(/\.mp4$/, '.poster.jpg'), label: unknown = 'Улов') => ({ key, poster, label });

describe('разбор клипов тура', () => {
  it('ключ под videos/ превращается в адрес хранилища', () => {
    expect(parseTourClips([clip('videos/fishingkam/a.mp4')], BASE)).toEqual([
      { url: `${BASE}/videos/fishingkam/a.mp4`, poster: `${BASE}/videos/fishingkam/a.poster.jpg`, label: 'Улов' },
    ]);
  });

  it('чужой ключ, чужая обложка, обход каталога и не-массив — отбрасываются', () => {
    expect(parseTourClips([clip('places/x/a.mp4')], BASE)).toEqual([]);
    expect(parseTourClips([clip('videos/a.mp4', 'https://evil.example/a.jpg')], BASE)).toEqual([]);
    expect(parseTourClips([clip('videos/../maps/a.mp4')], BASE)).toEqual([]);
    expect(parseTourClips([clip('videos/a.webm')], BASE)).toEqual([]);
    expect(parseTourClips({ key: 'videos/a.mp4' }, BASE)).toEqual([]);
  });

  it('хранилище не настроено — клипов нет; пустая подпись — общая', () => {
    expect(parseTourClips([clip('videos/a.mp4')], null)).toEqual([]);
    expect(parseTourClips([clip('videos/a.mp4', undefined, '  ')], BASE)[0]?.label).toBe('Видео тура');
  });

  it('не больше шести', () => {
    const many = Array.from({ length: 9 }, (_, i) => clip(`videos/c${i}.mp4`));
    expect(parseTourClips(many, BASE)).toHaveLength(MAX_TOUR_CLIPS);
  });
});

describe('файлы и заливка', () => {
  const marker = JSON.parse(read(MARKER)) as { upload: boolean; items: Array<{ file: string; key: string }> };

  it('каждая строка маркера проходит проверку заливки', () => {
    expect(marker.items.length).toBeGreaterThan(0);
    for (const it of marker.items) expect(typeof checkItem(it, ROOT), it.file).toBe('object');
  });

  it('клипы без звука: в MP4 есть дорожка видео и нет дорожки звука', () => {
    for (const it of marker.items.filter((i) => i.file.endsWith('.mp4'))) {
      const bytes = readFileSync(join(ROOT, it.file)).toString('latin1');
      expect(bytes, it.file).toMatch(/hdlr\0{8}vide/);
      expect(bytes, it.file).not.toMatch(/hdlr\0{8}soun/);
    }
  });

  it('проверка заливки отказывает вне media/s3/ и вне videos/', () => {
    expect(checkItem({ file: 'public/video/shatun/clip-ferry-rope.mp4', key: 'videos/x.mp4' }, ROOT)).toMatch(/только из media\/s3/);
    expect(checkItem({ file: 'media/s3/videos/fishingkam/clip-fish-catch.mp4', key: 'maps/x.mp4' }, ROOT)).toMatch(/только под videos/);
    expect(checkItem({ file: 'media/s3/../package.json', key: 'videos/x.mp4' }, ROOT)).toMatch(/только из media\/s3/);
    expect(checkItem({ file: 'media/s3/videos/fishingkam/clip-fish-catch.mp4', key: 'videos/x.jpg' }, ROOT)).toMatch(/расходятся/);
  });

  it('workflow зовёт скрипт по маркеру и читает обратно; media/ не едет в образ', () => {
    const wf = read('.github/workflows/media-to-s3.yml');
    expect(wf).toContain("- '.github/triggers/media-to-s3.json'");
    expect(wf).toContain('npx tsx scripts/media-to-s3.ts $FLAG');
    expect(read('scripts/media-to-s3.ts')).toMatch(/прочитан обратно/);
    expect(read('.dockerignore')).toMatch(/^media\/$/m);
  });
});

describe('миграция 1191', () => {
  const sql = read('migrations/1191_tour_video_clips.sql');

  it('колонка-массив и только ключи из маркера заливки', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS video_clips JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(sql).toMatch(/operator_tours_video_clips_shape/);
    const marker = JSON.parse(read(MARKER)) as { items: Array<{ key: string; file: string }> };
    const uploaded = new Set(marker.items.map((i) => i.key));
    const keys = [...sql.matchAll(/'(videos\/[^']+)'/g)].map((m) => m[1]);
    expect(keys.length).toBe(12);
    for (const k of keys) {
      expect(uploaded.has(k), k).toBe(true);
      expect(existsSync(join(ROOT, 'media/s3', k)), k).toBe(true);
    }
  });

  it('открытая вода — не зимним турам, лёд — только зимним; чужая правка не затирается', () => {
    const [summer, winter] = sql.split(/-- Зимним \(подлёдным\) турам — свои клипы/);
    expect(summer).toMatch(/ot\.title !~\* 'зимн\|подлёдн\|подледн'/);
    expect(summer).not.toMatch(/clip-ice-/);
    expect(winter).toMatch(/ot\.title ~\* 'зимн\|подлёдн\|подледн'/);
    expect(winter).toMatch(/clip-ice-catch/);
    expect(winter).not.toMatch(/clip-fish-/);
    expect(sql.match(/AND ot\.video_clips = '\[\]'::jsonb/g)).toHaveLength(2);
  });
});

describe('карточка тура и CSP', () => {
  it('сервер собирает адреса, ключи до клиента не доходят', () => {
    const q = read('lib/tours/tour-detail-query.ts');
    expect(q).toMatch(/ot\.video_clips/);
    expect(q).toMatch(/const \{ video_clips, \.\.\.rest \} = row;/);
    expect(q).toMatch(/clips: tourClips\(video_clips\)/);
  });

  it('клиент рисует LazyClip и берёт из модуля клипов только тип', () => {
    const c = read('app/catalog/tours/[id]/_TourDetailClient.tsx');
    expect(c).toContain("import type { TourClip } from '@/lib/tours/tour-clips';");
    expect(c).not.toMatch(/import \{[^}]*\} from '@\/lib\/tours\/tour-clips'/);
    expect(c).not.toMatch(/from '@\/lib\/storage\/s3'/);
    expect(c).toMatch(/<LazyClip url=\{c\.url\} poster=\{c\.poster\} label=\{c\.label\}/);
    // Автор — оператор тура (слово владельца 09.10).
    expect(c).toContain('Видео: {tour.operator_name}');
  });

  it('CSP пускает видео из хранилища в обеих политиках страниц', () => {
    const mw = read('middleware.ts');
    expect(mw).toContain(`const mediaSrc = "'self' https://s3.twcstorage.ru";`);
    expect(mw).toMatch(/img-src \$\{imgSrc\}; media-src \$\{mediaSrc\};/);
    const cfg = read('next.config.js');
    expect(cfg).toMatch(/blob:; media-src 'self' https:\/\/s3\.twcstorage\.ru; connect-src/);
  });
});
