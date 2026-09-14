/**
 * Галерея места: у механизма есть производитель, потребитель и счётчик.
 *
 * ── Что нашлось 14.09 ─────────────────────────────────────────────────────
 *
 * Владелец прислал два десятка своих фотографий. На карточки попало
 * одиннадцать — по одной на место, — а девять класть было НЕКУДА: в
 * `ai_route_images` уникальный индекс по `route_id` с миграции 107, одно
 * место = один снимок.
 *
 * При этом галерея на карточке уже была написана: `PlaceHero` умеет свайп,
 * снаппинг и счётчик «3/7» и включается при `images.length > 1`. Кормился
 * он из `places.images` — списка ССЫЛОК, собранного импортом с чужих
 * сайтов, — то есть у нашего собственного снимка производителя для этого
 * механизма не было вовсе. Правило 10.09 в чистом виде: экран обещает
 * галерею, а положить в неё второй кадр нечем.
 *
 * ── Почему отдельная таблица, а не position в ai_route_images ─────────────
 *
 * `ON CONFLICT (route_id)` стоит в двадцати одном месте, включая ДЕСЯТЬ уже
 * применённых миграций. Вывод типов ON CONFLICT требует уникального индекса
 * ровно по названным колонкам — с индексом по (route_id, position) все они
 * ответят 42P10, а править применённые миграции нельзя: они идут только
 * вперёд и на чистой базе переиграются. Отсюда `place_gallery_photos`
 * (миграция 968) рядом с нетронутым героем.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 *   производитель — таблица 968 и раздача байтов;
 *   провод        — gallery_urls в /api/places/[id] и склейка героя с галереей;
 *   потребитель   — images доезжает до PlaceHero, а тот включает свайп;
 *   счётчик       — photoCount считает ГАЛЕРЕЮ ТОЖЕ, иначе «3/7» врёт.
 *
 * Порвётся любое звено — галерея молча схлопнется в одно фото, и снаружи
 * это будет неотличимо от «у места один снимок» (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const MIGRATION = read('migrations/968_place_gallery_photos.sql');
const API = read('app/api/places/[id]/route.ts');
const RASTER = read('app/api/images/place-gallery/[arkId]/[position]/route.ts');
const CLIENT = read('app/places/[id]/_PlaceDetailClient.tsx');
const HERO = read('components/places/PlaceHero.tsx');
const UPLOAD = read('app/api/admin/places/[id]/photo/route.ts');
const ADMIN_UI = read('app/hub/admin/places-photos/_PlacesPhotosClient.tsx');

describe('производитель — таблица галереи', () => {
  it('миграция заводит place_gallery_photos', () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS place_gallery_photos/);
  });

  it('порядок в пределах места однозначен', () => {
    // Без уникального индекса две фотографии могут оказаться обе второй, и
    // ORDER BY position перестаёт задавать порядок: галерея тасуется от
    // запроса к запросу.
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS place_gallery_photos_ark_position_idx\s+ON place_gallery_photos \(ark_id, position\)/,
    );
  });

  it('строка без байтов и без ссылки не заводится', () => {
    // Иначе в галерее появляется позиция, по которой отдавать нечего: счётчик
    // считает её, а человек видит пустой кадр.
    expect(MIGRATION).toMatch(/CHECK \(image_data IS NOT NULL OR s3_url IS NOT NULL\)/);
  });

  it('герой не трогается: ни ALTER, ни DROP по ai_route_images', () => {
    // Ровно то, ради чего заведена отдельная таблица. Снятие уникального
    // индекса здесь обрушило бы десять применённых миграций на 42P10 при
    // накате на чистую базу. Упоминания в тексте (шапка, COMMENT ON) не
    // запрещены — объяснить решение надо именно здесь; запрещено ДЕЙСТВИЕ.
    expect(MIGRATION).not.toMatch(/ALTER TABLE\s+(IF EXISTS\s+)?ai_route_images/i);
    expect(MIGRATION).not.toMatch(/DROP INDEX[\s\S]{0,80}ai_route_images/i);
  });
});

describe('раздача снимка галереи', () => {
  it('читает place_gallery_photos параметризованно', () => {
    expect(RASTER).toMatch(/FROM place_gallery_photos/);
    expect(RASTER).toMatch(/WHERE ark_id = \$1::uuid AND position = \$2/);
  });

  it('нулевая позиция не обслуживается: герой лежит в другой таблице', () => {
    expect(RASTER).toMatch(/pos < 1/);
  });

  it('отказ хранилища не выдаётся за «снимка нет»', () => {
    // 404 на упавшем запросе означал бы «фотографии не существует» — третий
    // исход, выданный за первый (§4.0). Здесь 503 и строка в логе.
    expect(RASTER).toMatch(/console\.error\(/);
    expect(RASTER).toMatch(/status: 503/);
  });
});

describe('провод — карточка узнаёт, что снимков больше одного', () => {
  it('/api/places/[id] собирает адреса галереи', () => {
    expect(API).toMatch(/FROM place_gallery_photos g/);
    expect(API).toMatch(/AS gallery_urls/);
  });

  it('адреса упорядочены по position', () => {
    expect(API).toMatch(/ORDER BY g\.position/);
  });

  it('пустая галерея — пустой список, а не NULL', () => {
    // COALESCE(..., '[]') держит форму: потребитель ждёт массив, и `null`
    // здесь означал бы падение на .length, а не «галереи нет».
    expect(API).toMatch(/COALESCE\(json_agg\(/);
    expect(API).toMatch(/'\[\]'::json\)/);
  });

  it('герой идёт первым, галерея за ним', () => {
    expect(API).toMatch(/\[\.\.\.hero, \.\.\.gallery\]/);
  });

  it('photoCount считает галерею тоже', () => {
    // Счётчик «3/7» в PlaceHero судит по этому числу, когда галереи нет.
    // Пока оно означало «есть ли настоящее фото», дальше единицы оно не
    // росло — и подпись под снимком врала бы о количестве.
    expect(API).toMatch(/photoCount:\s*Number\(r\.photo_count\) \+ /);
    expect(API).toMatch(/gallery_urls as unknown\[\] \| null\)\?\.length/);
  });
});

describe('наполнение — второй снимок не стирает первый', () => {
  // Без этого блока таблица была бы объявлением без источника (правило
  // 10.09): место, куда никто не пишет. Живой производитель — ручная
  // загрузка из админки.
  it('решает по наличию героя, а не по догадке', () => {
    expect(UPLOAD).toMatch(/FROM ai_route_images WHERE route_id = \$1/);
    expect(UPLOAD).toMatch(/hasHero && !replaceHero/);
  });

  it('второй снимок кладётся в галерею', () => {
    expect(UPLOAD).toMatch(/INSERT INTO place_gallery_photos/);
  });

  it('замена героя требует сказать это вслух', () => {
    expect(UPLOAD).toMatch(/replace_hero/);
  });

  it('позиция берётся отдельным запросом, а не INSERT ... SELECT MAX', () => {
    // У `INSERT INTO t (...) SELECT $1, MAX(...)` параметрам негде взять
    // якорь типа: 42P08 «inconsistent types deduced», запрос не выполняется
    // НИКОГДА (CLAUDE.md §4, случай 24.08).
    expect(UPLOAD).not.toMatch(/INSERT INTO place_gallery_photos[\s\S]{0,400}SELECT/);
    expect(UPLOAD).toMatch(/SELECT COALESCE\(MAX\(position\), 0\) \+ 1/);
  });

  it('отказ записи не выдаётся за успех', () => {
    expect(UPLOAD).toMatch(/console\.error\('\[place-photo\]/);
    expect(UPLOAD).toMatch(/status: 503/);
  });

  it('ответ называет, куда лёг снимок', () => {
    expect(UPLOAD).toMatch(/slot: 'gallery'/);
    expect(UPLOAD).toMatch(/slot: 'hero'/);
  });

  it('админка предлагает оба действия и показывает исход', () => {
    expect(ADMIN_UI).toMatch(/Добавить в галерею/);
    expect(ADMIN_UI).toMatch(/Заменить главное фото/);
    expect(ADMIN_UI).toMatch(/fd\.append\('replace_hero', 'true'\)/);
    expect(ADMIN_UI).toMatch(/data\.slot === 'gallery'/);
  });
});

describe('потребитель — галерея доезжает до экрана', () => {
  it('карточка передаёт images в PlaceHero', () => {
    expect(CLIENT).toMatch(/images=\{place\.images/);
  });

  it('PlaceHero включает свайп при более чем одном снимке', () => {
    expect(HERO).toMatch(/images && images\.length > 1/);
    expect(HERO).toMatch(/const isGallery = gallery\.length > 1/);
  });
});
