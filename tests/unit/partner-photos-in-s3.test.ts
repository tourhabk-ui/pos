/**
 * Снимки партнёров живут в хранилище, а не в папке сайта (08.11, владелец:
 * «да и разберись почему грузяться не сразу в s3»).
 *
 * Почему они оказались в public/images. Раздача из хранилища
 * (/api/images/s3/) знала только `photos/…jpg`, а уменьшенные копии
 * `.320/.640/.1280.webp` (scripts/optimize-images.mjs) нарезались только из
 * public/images. Хочешь, чтобы снимок тура грузился на телефоне быстро, —
 * клади его в папку сайта; так 932 снимка партнёров (83 МБ) уехали в образ.
 * Закачка с сайтов операторов (operator-photos.yml) клала оригиналы туда же.
 * Правило §4.1 «байтам снимка не место в базе» и его сторож смотрели только
 * на базу.
 *
 * Здесь:
 *   - папки public/images делятся на оформление сайта и папки партнёров;
 *     новая папка — красная, пока ей не назван род;
 *   - в папках партнёров, ещё оставшихся в папке сайта (три логотипа и
 *     эскизы без ссылок), число файлов заморожено и может только убывать
 *     (запись самоустаревает: уменьшилось — поправь число);
 *   - переехавшие папки (08.11, #3150, #3151, миграция 1406) в папку сайта не
 *     возвращаются, их снимки лежат в media/s3/photos и стоят в маркере, а
 *     старый адрес переадресуется на хранилище;
 *   - закачка с сайтов операторов кладёт оригиналы не в папку сайта.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MARKER } from '@/scripts/media-to-s3';
import { MOVED_PHOTO_DIRS } from '../helpers/partner-photo-path';

const ROOT = process.cwd();
const PUB = join(ROOT, 'public/images');

/** Оформление сайта: снимки и графика платформы, не материалы партнёров. */
const SITE: Readonly<Record<string, string>> = {
  activities: 'плитки видов отдыха',
  bento: 'плитки главной',
  bg: 'фоны',
  brand: 'знак Ведара',
  carousel: 'карусель',
  categories: 'плитки категорий',
  fish: 'справочник рыб',
  gallery: 'галерея оформления',
  hero: 'герой главной',
  logo: 'логотип платформы',
  marketplace: 'герой и плитки витрины',
  nav: 'иконки навигации',
  og: 'превью для соцсетей',
  social: 'иконки соцсетей',
};

/**
 * Папки партнёров в папке сайта: число файлов. Только убывает. Переезд в
 * хранилище — по папке целиком: копия в media/s3/photos, заливка, пути в
 * базе, удаление отсюда.
 */
const PARTNER_FROZEN: Readonly<Record<string, number>> = {
  // Ещё не в хранилище: эскизы без ссылок и три логотипа.
  operators: 12,
  'laguna-expedition': 1,
  'river-tours-kamchatka': 1,
  virtustur: 1,
};

/**
 * Переехали в хранилище целиком (08.11): копия в media/s3/photos/<папка>/
 * (прогон 21), адреса в базе — миграция 1406, старый адрес переадресуется
 * (next.config.js). В папке сайта их больше нет.
 */
const MOVED = MOVED_PHOTO_DIRS;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const dirs = readdirSync(PUB, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

describe('public/images: оформление сайта отдельно, снимки партнёров — в хранилище', () => {
  it('у каждой папки назван род: оформление или партнёр', () => {
    const unnamed = dirs.filter((d) => !(d in SITE) && !(d in PARTNER_FROZEN));
    // Снимки партнёра — в media/s3/photos/<партнёр>/ и маркер media-to-s3, не сюда.
    expect(unnamed, 'новая папка в public/images').toEqual([]);
  });

  it('в папках партнёров файлов не прибавляется; убыло — поправь число здесь', () => {
    const counts = Object.fromEntries(
      Object.keys(PARTNER_FROZEN).filter((d) => dirs.includes(d)).map((d) => [d, filesUnder(join(PUB, d)).length]),
    );
    const expected = Object.fromEntries(Object.entries(PARTNER_FROZEN).filter(([d]) => dirs.includes(d)));
    expect(counts).toEqual(expected);
    // Папка ушла целиком — запись тоже уходит.
    const gone = Object.keys(PARTNER_FROZEN).filter((d) => !dirs.includes(d));
    expect(gone, 'папки нет, а запись осталась').toEqual([]);
  });

  it('переехавшие папки: в папке сайта их нет, в media/s3/photos они есть и стоят в маркере', () => {
    const marker = JSON.parse(readFileSync(join(ROOT, MARKER), 'utf-8')) as {
      upload: boolean; items: Array<{ file: string; key: string }>;
    };
    const keys = new Set(marker.items.map((i) => i.key));
    expect(marker.upload).toBe(true);
    for (const d of MOVED) {
      expect(existsSync(join(PUB, d)), `public/images/${d} снова есть`).toBe(false);
      const files = filesUnder(join(ROOT, 'media/s3/photos', d));
      expect(files.length, d).toBeGreaterThan(0);
      const lost = files.map((f) => relative(join(ROOT, 'media/s3'), f).split('\\').join('/')).filter((k) => !keys.has(k));
      expect(lost, d).toEqual([]);
    }
  });

  it('старый адрес переехавшей папки переадресуется на хранилище: ссылка вне базы не теряет снимок', async () => {
    const config = require(join(ROOT, 'next.config.js')) as {
      redirects: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>>;
    };
    const rules = await config.redirects();
    for (const d of MOVED) {
      expect(rules.find((r) => r.source === `/images/${d}/:path*`), d).toEqual({
        source: `/images/${d}/:path*`,
        destination: `/api/images/s3/photos/${d}/:path*`,
        permanent: true,
      });
    }
    // Оформление сайта не переадресуется.
    expect(rules.some((r) => r.source.startsWith('/images/hero'))).toBe(false);
  });

  it('закачка с сайтов операторов кладёт оригиналы не в папку сайта', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/operator-photos.yml'), 'utf-8');
    // Команды шага, не комментарии: куда пишется файл и что коммитится.
    expect(wf).not.toMatch(/^\s*(DIR=|git add).*public\//m);
    expect(wf).toMatch(/^\s*DIR="media\/raw\/\$SLUG"$/m);
    expect(wf).toMatch(/^\s*git add "media\/raw\/\$SLUG"$/m);
  });
});
