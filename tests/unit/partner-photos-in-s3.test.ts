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
 *   - в папках партнёров число файлов заморожено и может только убывать
 *     (запись самоустаревает: уменьшилось — поправь число);
 *   - у каждого снимка партнёра в папке сайта есть та же копия байт в байт в
 *     media/s3/photos/<папка>/ и строка маркера заливки — следующий PR может
 *     переключить пути в базе, не потеряв ни одного снимка;
 *   - закачка с сайтов операторов кладёт оригиналы не в папку сайта.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MARKER } from '@/scripts/media-to-s3';

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
  fishingkam: 111,
  kutha: 66,
  'laguna-prokat': 32,
  mestechko: 253,
  partners: 63,
  shatun: 86,
  tours: 74,
  volcanoesland: 136,
  zaporozhets: 96,
  zheltukhin: 14,
  // Ещё не скопированы в хранилище: эскизы без ссылок и три логотипа.
  operators: 12,
  'laguna-expedition': 1,
  'river-tours-kamchatka': 1,
  virtustur: 1,
};

/** Скопированы в media/s3/photos/<та же папка>/ (маркер, прогон 21). */
const COPIED = [
  'fishingkam', 'kutha', 'laguna-prokat', 'mestechko', 'partners',
  'shatun', 'tours', 'volcanoesland', 'zaporozhets', 'zheltukhin',
];

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

  it('у каждого снимка скопированной папки — та же копия в media/s3/photos и строка маркера', () => {
    const marker = JSON.parse(readFileSync(join(ROOT, MARKER), 'utf-8')) as {
      upload: boolean; items: Array<{ file: string; key: string }>;
    };
    const items = new Map(marker.items.map((i) => [i.key, i.file]));
    expect(marker.upload).toBe(true);
    const problems: string[] = [];
    for (const d of COPIED) {
      for (const abs of filesUnder(join(PUB, d))) {
        const rel = relative(PUB, abs).split('\\').join('/');
        const key = `photos/${rel}`;
        const copy = join(ROOT, 'media/s3', key);
        let same = false;
        try {
          same = statSync(copy).size === statSync(abs).size && readFileSync(copy).equals(readFileSync(abs));
        } catch {
          problems.push(`${rel}: копии в media/s3 нет`);
          continue;
        }
        if (!same) problems.push(`${rel}: копия отличается`);
        if (items.get(key) !== `media/s3/${key}`) problems.push(`${rel}: нет строки маркера`);
      }
    }
    expect(problems).toEqual([]);
    // Читает обе копии ~930 снимков (около 170 МБ): на занятом раннере дольше пяти секунд.
  }, 60_000);

  it('закачка с сайтов операторов кладёт оригиналы не в папку сайта', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/operator-photos.yml'), 'utf-8');
    // Команды шага, не комментарии: куда пишется файл и что коммитится.
    expect(wf).not.toMatch(/^\s*(DIR=|git add).*public\//m);
    expect(wf).toMatch(/^\s*DIR="media\/raw\/\$SLUG"$/m);
    expect(wf).toMatch(/^\s*git add "media\/raw\/\$SLUG"$/m);
  });
});
