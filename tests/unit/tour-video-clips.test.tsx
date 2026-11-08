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
 * - клиент не тянет S3-клиент в бандл: из модуля клипов — только тип;
 * - лента на карточке проверяется РЕНДЕРОМ (13.10, карт-бланш владельца на
 *   сторожей по регулярке): каждый клип получает адрес, обложку и подпись из
 *   серверной строки, автор подписан оператором, и имя ведёт на его страницу.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import React from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTourClips, MAX_TOUR_CLIPS } from '@/lib/tours/tour-clips';
import { checkItem, MARKER } from '../../scripts/media-to-s3';

// Сам LazyClip проверяет tests/unit/lazy-clip; здесь важно, ЧТО ему передали.
vi.mock('@/components/media/LazyClip', () => ({
  LazyClip: (p: { url: string; poster: string; label: string }) =>
    React.createElement('div', { 'data-testid': 'clip', 'data-url': p.url, 'data-poster': p.poster, 'aria-label': p.label }),
}));
import { TourClips } from '@/components/tours/TourClips';

afterEach(cleanup);

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

  it('не больше восьми (владелец 07.11: «подними до 8»)', () => {
    expect(MAX_TOUR_CLIPS).toBe(8);
    const many = Array.from({ length: 11 }, (_, i) => clip(`videos/c${i}.mp4`));
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

  it('снимки мест (14.10): под photos/ — только JPEG, видео туда не кладётся', () => {
    const ok = checkItem({ file: 'media/s3/photos/kronotsky/kaldera-uzona.jpg', key: 'photos/kronotsky/kaldera-uzona.jpg' }, ROOT);
    expect(typeof ok).toBe('object');
    expect(checkItem({ file: 'media/s3/videos/fishingkam/clip-fish-catch.mp4', key: 'photos/x.mp4' }, ROOT)).toMatch(/только снимки \.jpg/);
    // Уборка сирот распоряжается places/<uuid>/ — этим путём туда не пишется.
    expect(checkItem({ file: 'media/s3/photos/kronotsky/kaldera-uzona.jpg', key: 'places/kronotsky/kaldera-uzona.jpg' }, ROOT)).toMatch(/только под videos\//);
  });

  it('workflow зовёт скрипт по маркеру и читает обратно; media/ не едет в образ', () => {
    const wf = read('.github/workflows/media-to-s3.yml');
    expect(wf).toContain("- '.github/triggers/media-to-s3.json'");
    expect(wf).toContain('npx tsx scripts/media-to-s3.ts $FLAG');
    expect(read('scripts/media-to-s3.ts')).toMatch(/прочитан обратно/);
    expect(read('.dockerignore')).toMatch(/^media\/$/m);
  });
});

describe('миграция 1194', () => {
  const sql = read('migrations/1194_tour_video_clips.sql');

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

describe('миграция 1340 (клипы Курильского у туров гида)', () => {
  const sql = read('migrations/1340_guide_kurile_lake_clips.sql');

  it('ключи — только из маркера заливки и лежат в media/s3; вертолёта во внедорожном туре нет', () => {
    const marker = JSON.parse(read(MARKER)) as { items: Array<{ key: string; file: string }> };
    const uploaded = new Set(marker.items.map((i) => i.key));
    const keys = [...sql.matchAll(/'(videos\/[^']+)'/g)].map((m) => m[1]);
    expect(keys).toHaveLength(12);
    for (const k of keys) {
      expect(uploaded.has(k), k).toBe(true);
      expect(existsSync(join(ROOT, 'media/s3', k)), k).toBe(true);
    }
    expect(sql).not.toMatch(/vertolet|helicopter/);
  });

  it('только два тура Курильского и только пустой список', () => {
    expect(sql).toMatch(/WHERE ot\.slug IN \('zaporozhets-kurilskoe-ozero-3-dnya', 'zaporozhets-kurilskoe-ozero-4-dnya'\)/);
    expect(sql).toMatch(/AND ot\.video_clips = '\[\]'::jsonb;/);
  });
});

describe('миграция 1398 (клипы Вачкажца у тура гида)', () => {
  const sql = read('migrations/1398_guide_vachkazhets_clips.sql');

  it('ключи — только из маркера заливки и лежат в media/s3; каждый клип — H.264 без звука', () => {
    const marker = JSON.parse(read(MARKER)) as { items: Array<{ key: string; file: string }> };
    const uploaded = new Set(marker.items.map((i) => i.key));
    const keys = [...sql.matchAll(/'(videos\/[^']+)'/g)].map((m) => m[1]!);
    expect(keys).toHaveLength(6);
    for (const k of keys) {
      expect(uploaded.has(k), k).toBe(true);
      expect(existsSync(join(ROOT, 'media/s3', k)), k).toBe(true);
    }
    for (const k of keys.filter((x) => x.endsWith('.mp4'))) {
      const meta = readFileSync(join(ROOT, 'media/s3', k)).toString('latin1');
      expect(meta, k).toContain('avc1');
      expect(meta, k).not.toMatch(/hdlr\0{8}soun/);
    }
  });

  it('только тур «Вачкажец + озёрки»; клипы дописываются к своим, без повтора и не больше восьми', () => {
    expect(sql).toMatch(/WHERE t\.slug = 'zaporozhets-vachkazhets-ozerki'/);
    expect(sql).toMatch(/SET video_clips = ot\.video_clips \|\| a\.items/);
    expect(sql).toMatch(/NOT EXISTS \([\s\S]*e->>'key' = cl\.c->>'key'/);
    expect(sql).toMatch(/WHERE k <= 8 - have/);
  });
});

describe('миграция 1404 (клипы «Местечка Камчатка» — с его сайта и из его канала)', () => {
  const sql = read('migrations/1404_mestechko_tour_clips.sql');
  const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  const pairs = [...code.matchAll(/\('(mestechko-[a-z-]+)', (\d+),\s*jsonb_build_object\('key', '(videos\/[^']+)'/g)]
    .map((m) => ({ slug: m[1]!, n: Number(m[2]), key: m[3]! }));

  it('ключи — только из маркера заливки и лежат в media/s3; каждый клип — H.264 без звука', () => {
    const marker = JSON.parse(read(MARKER)) as { items: Array<{ key: string; file: string }> };
    const uploaded = new Set(marker.items.map((i) => i.key));
    const keys = [...code.matchAll(/'(videos\/[^']+)'/g)].map((m) => m[1]!);
    expect(keys).toHaveLength(32);
    for (const k of keys) {
      expect(k.startsWith('videos/mestechko/'), k).toBe(true);
      expect(uploaded.has(k), k).toBe(true);
      expect(existsSync(join(ROOT, 'media/s3', k)), k).toBe(true);
    }
    for (const k of keys.filter((x) => x.endsWith('.mp4'))) {
      const meta = readFileSync(join(ROOT, 'media/s3', k)).toString('latin1');
      expect(meta, k).toContain('avc1');
      expect(meta, k).not.toMatch(/hdlr\0{8}soun/);
    }
  });

  it('только туры «Местечка»; у тура свой порядок; чужой кадр туру не ставится', () => {
    expect(pairs).toHaveLength(16);
    expect(new Set(pairs.map((p) => p.key)).size).toBe(16);
    expect(code).toMatch(/p\.slug = 'mestechko'/);
    // Порядок внутри тура — 1, 2, 3…: клип сайта первым, клипы канала за ним.
    const bySlug = new Map<string, number[]>();
    for (const p of pairs) bySlug.set(p.slug, [...(bySlug.get(p.slug) ?? []), p.n]);
    for (const [slug, ns] of bySlug) expect(ns, slug).toEqual(ns.map((_, i) => i + 1));
    expect(bySlug.get('mestechko-kurilskoe-ozero')).toHaveLength(4);
    // Ролик Толмачёва сайт показывает и у пляжа, и у Толбачика — у нас он только у Толмачёва.
    expect(pairs.filter((p) => p.key.includes('tolmachevo')).map((p) => p.slug)).toEqual(['mestechko-ozero-tolmachevo']);
    for (const s of ['mestechko-halaktyrskiy-plyazh', 'mestechko-tolbachik-standard', 'mestechko-avachinskiy-pereval']) {
      expect(bySlug.has(s), s).toBe(false);
    }
  });

  it('клипы дописываются к своим по порядку, без повтора и не больше восьми', () => {
    expect(code).toMatch(/SET video_clips = ot\.video_clips \|\| a\.items/);
    expect(code).toMatch(/jsonb_agg\(c ORDER BY n\)/);
    expect(code).toMatch(/NOT EXISTS \([\s\S]*e->>'key' = cl\.c->>'key'/);
    expect(code).toMatch(/WHERE k <= 8 - have/);
  });
});

describe('миграция 1405 (клипы «Лагуны Экспедиции» — из роликов её сайта и её канала)', () => {
  const sql = read('migrations/1405_laguna_expedition_tour_clips.sql');
  const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  const pairs = [...code.matchAll(/\('(lagexp-[a-z0-9-]+)', (\d+),\s*jsonb_build_object\('key', '(videos\/[^']+)'/g)]
    .map((m) => ({ slug: m[1]!, n: Number(m[2]), key: m[3]! }));
  const tourSlugs = new Set(
    [...read('migrations/1339_laguna_expedition_tours.sql').matchAll(/'(lagexp-[a-z0-9-]+)'::text/g)].map((m) => m[1]!),
  );

  it('ключи — только из маркера заливки и лежат в media/s3; каждый клип — H.264 без звука, вертикаль', () => {
    const marker = JSON.parse(read(MARKER)) as { items: Array<{ key: string; file: string }> };
    const uploaded = new Set(marker.items.map((i) => i.key));
    const keys = new Set([...code.matchAll(/'(videos\/[^']+)'/g)].map((m) => m[1]!));
    expect(keys.size).toBe(26);
    for (const k of keys) {
      expect(k.startsWith('videos/lagexp/'), k).toBe(true);
      expect(uploaded.has(k), k).toBe(true);
      expect(existsSync(join(ROOT, 'media/s3', k)), k).toBe(true);
    }
    for (const k of [...keys].filter((x) => x.endsWith('.mp4'))) {
      const meta = readFileSync(join(ROOT, 'media/s3', k)).toString('latin1');
      expect(meta, k).toContain('avc1');
      expect(meta, k).not.toMatch(/hdlr\0{8}soun/);
    }
  });

  it('только туры «Лагуны Экспедиции» из 1339; у тура свой порядок; чужое место туру не ставится', () => {
    expect(pairs).toHaveLength(28);
    expect(code).toMatch(/p\.slug = 'laguna-expedition'/);
    for (const p of pairs) expect(tourSlugs.has(p.slug), p.slug).toBe(true);
    const bySlug = new Map<string, number[]>();
    for (const p of pairs) bySlug.set(p.slug, [...(bySlug.get(p.slug) ?? []), p.n]);
    for (const [slug, ns] of bySlug) expect(ns, slug).toEqual(ns.map((_, i) => i + 1));
    const toursOf = (clip: string) => pairs.filter((p) => p.key === `videos/lagexp/${clip}.mp4`).map((p) => p.slug).sort();
    // Осенний мыс Маячный — не зимнему снегоходному туру туда же.
    expect(toursOf('clip-mayak')).toEqual(['lagexp-mys-mayachnyj-khalaktyrskij-plyazh', 'lagexp-na-kraj-sveta-mys-mayachnyj']);
    expect(bySlug.has('lagexp-mys-mayachnyj')).toBe(false);
    // Зимний Халактыр — туда, где он днём программы, а не заменой по погоде.
    expect(toursOf('clip-khalaktyr-zima')).toEqual([
      'lagexp-novogodnie-vulkany-kamchatki-laguna-4',
      'lagexp-novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki',
      'lagexp-siti-tur-tuda-gde-vstaet-solntse',
    ]);
    expect(bySlug.has('lagexp-novyj-god-na-kamchatke')).toBe(false);
    // Озеро — только туру с днём на Толмачёва; снегоход с нартой — только туру в нарте.
    expect(toursOf('clip-ozero-tolmacheva')).toEqual(['lagexp-kamchatka-na-maksimum-osennij-marshrut']);
    expect(toursOf('clip-dva-vulkana')).toEqual(['lagexp-dva-vulkana-avachinskij-pereval']);
    // Чьё стойбище и какой источник в «Днях 1 и 3» — неизвестно: этих туров клипы не касаются.
    for (const s of ['lagexp-pogruzhenie-v-kulturu-severa', 'lagexp-pitomnik-ezdovykh-sobak-snezhnye-psy', 'lagexp-karymshinskie-termalnye-istochniki', 'lagexp-malkinskie-dikie-goryachie-mineralnye-istochniki']) {
      expect(bySlug.has(s), s).toBe(false);
    }
  });

  it('клипы дописываются к своим по порядку, без повтора и не больше восьми', () => {
    expect(code).toMatch(/SET video_clips = ot\.video_clips \|\| a\.items/);
    expect(code).toMatch(/jsonb_agg\(c ORDER BY n\)/);
    expect(code).toMatch(/NOT EXISTS \([\s\S]*e->>'key' = cl\.c->>'key'/);
    expect(code).toMatch(/WHERE k <= 8 - have/);
    expect(code).toMatch(/t\.deleted_at IS NULL/);
  });
});

describe('миграция 1399 (курильские туры гида: пар вместо «Двух медведей», ещё медведь и лошади)', () => {
  const sql = read('migrations/1399_guide_kurile_lake_clips_more.sql');
  const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

  it('ключи — только из маркера заливки и лежат в media/s3; новые клипы — H.264 без звука', () => {
    const marker = JSON.parse(read(MARKER)) as { items: Array<{ key: string; file: string }> };
    const uploaded = new Set(marker.items.map((i) => i.key));
    const keys = new Set([...code.matchAll(/'(videos\/[^']+)'/g)].map((m) => m[1]!));
    expect([...keys].filter((k) => k.includes('clip-kurile-'))).toHaveLength(6);
    expect(keys.has('videos/zaporozhets/clip-two-bears.mp4')).toBe(true);
    for (const k of keys) {
      expect(uploaded.has(k), k).toBe(true);
      expect(existsSync(join(ROOT, 'media/s3', k)), k).toBe(true);
    }
    for (const k of [...keys].filter((x) => x.includes('clip-kurile-') && x.endsWith('.mp4'))) {
      const meta = readFileSync(join(ROOT, 'media/s3', k)).toString('latin1');
      expect(meta, k).toContain('avc1');
      expect(meta, k).not.toMatch(/hdlr\0{8}soun/);
    }
  });

  it('оба тура Курильского; «Два медведя» → пар на том же месте, дописка без повтора, до восьми, повтор ничего не меняет', () => {
    expect(code).toMatch(/t\.slug IN \('zaporozhets-kurilskoe-ozero-3-dnya', 'zaporozhets-kurilskoe-ozero-4-dnya'\)/);
    // Замена: клип «Двух медведей» становится первым из новых (пар) в той же позиции.
    expect(code).toMatch(/WHEN x\.e->>'key' = 'videos\/zaporozhets\/clip-two-bears\.mp4'\s+THEN \(SELECT f\.c FROM fresh f WHERE f\.n = 1\)/);
    expect(code).toMatch(/'key', 'videos\/zaporozhets\/clip-kurile-steam\.mp4'[\s\S]{0,200}'label', 'Пар над склоном'\)/);
    expect(code).toMatch(/ORDER BY x\.i/);
    // Пар уже стоит — «Два медведя» просто убираются, второго пара нет.
    expect(code).toMatch(/NOT \(x\.e->>'key' = 'videos\/zaporozhets\/clip-two-bears\.mp4' AND t\.has_steam\)/);
    expect(code).toMatch(/NOT EXISTS \([\s\S]*e->>'key' = f\.c->>'key'/);
    expect(code).toMatch(/m\.k <= 8 - m\.have/);
    expect(code).toMatch(/ot\.video_clips IS DISTINCT FROM tg\.clips/);
    expect(code).toMatch(/t\.deleted_at IS NULL/);
  });
});

describe('карточка тура и CSP', () => {
  it('сервер собирает адреса, ключи до клиента не доходят', () => {
    const q = read('lib/tours/tour-detail-query.ts');
    expect(q).toMatch(/ot\.video_clips/);
    expect(q).toMatch(/const \{ video_clips, \.\.\.rest \} = row;/);
    expect(q).toMatch(/clips: tourClips\(video_clips\)/);
  });

  it('клиент берёт из модуля клипов только тип и не тянет S3-клиент; ленту рисует TourClips', () => {
    const c = read('app/catalog/tours/[id]/_TourDetailClient.tsx');
    expect(c).toContain("import type { TourClip } from '@/lib/tours/tour-clips';");
    expect(c).not.toMatch(/import \{[^}]*\} from '@\/lib\/tours\/tour-clips'/);
    expect(c).not.toMatch(/from '@\/lib\/storage\/s3'/);
    expect(c).toContain("from '@/components/tours/TourClips'");
    // Своей ленты у клиента нет: правило одно, и живёт оно в TourClips.
    expect(c).not.toMatch(/from '@\/components\/media\/LazyClip'/);
  });

  it('лента: каждому клипу — адрес, обложка и подпись из серверной строки; автор — оператор со ссылкой', () => {
    const clips = [
      { url: `${BASE}/videos/fishingkam/a.mp4`, poster: `${BASE}/videos/fishingkam/a.poster.jpg`, label: 'Улов' },
      { url: `${BASE}/videos/fishingkam/b.mp4`, poster: `${BASE}/videos/fishingkam/b.poster.jpg`, label: 'Подход к реке' },
    ];
    render(<TourClips clips={clips} operatorName="Камчатская рыбалка" operatorSlug="fishingkam" operatorPublic />);
    const items = within(screen.getByRole('list', { name: 'Клипы тура' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const second = within(items[1]).getByTestId('clip');
    expect(second.getAttribute('data-url')).toBe(clips[1].url);
    expect(second.getAttribute('data-poster')).toBe(clips[1].poster);
    expect(second.getAttribute('aria-label')).toBe('Подход к реке');
    expect(items[1]).toHaveTextContent('Подход к реке');
    // Автор — оператор тура (слово владельца 09.10); с 13.10 имя — ссылка на его страницу.
    const author = screen.getByText(/^Видео:/);
    const link = within(author).getByRole('link', { name: 'Камчатская рыбалка' });
    expect(link.getAttribute('href')).toBe('/operators/fishingkam');
  });

  it('закрытая карточка оператора — подпись текстом; без клипов — ничего', () => {
    const clip = { url: `${BASE}/videos/a.mp4`, poster: `${BASE}/videos/a.poster.jpg`, label: 'Улов' };
    const { container } = render(<TourClips clips={[clip]} operatorName="Камчатская рыбалка" operatorSlug="fishingkam" operatorPublic={false} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('Видео: Камчатская рыбалка');
    cleanup();
    const empty = render(<TourClips clips={[]} operatorName="Камчатская рыбалка" />);
    expect(empty.container.innerHTML).toBe('');
  });

  it('CSP пускает видео из хранилища в обеих политиках страниц', () => {
    const mw = read('middleware.ts');
    expect(mw).toContain(`const mediaSrc = "'self' https://s3.twcstorage.ru";`);
    expect(mw).toMatch(/img-src \$\{imgSrc\}; media-src \$\{mediaSrc\};/);
    const cfg = read('next.config.js');
    // В политике страниц next.config — ровно одна директива media-src с хранилищем
    // (её завёл #2310 для роликов перевозчика; второй экземпляр браузер бы проигнорировал).
    const pagePolicy = cfg.split('\n').find((l) => l.includes("key: 'Content-Security-Policy'") && l.includes('s3.twcstorage.ru')) ?? '';
    expect(pagePolicy.match(/media-src/g)).toHaveLength(1);
    expect(pagePolicy).toMatch(/media-src 'self' https:\/\/s3\.twcstorage\.ru;/);
  });
});
