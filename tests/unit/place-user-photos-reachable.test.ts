/**
 * Фото туриста доходит до карточки, а не теряется по дороге.
 *
 * ── Что нашлось 30.08 ─────────────────────────────────────────────────────
 *
 * Владелец собирался проверить загрузку фото «пользовательским режимом».
 * Разбор пути показал ДВА обрыва, и оба молчаливых:
 *
 *  1. Одобренные фото не показывались нигде. `GET /api/places/[id]/photos`
 *     отдаёт снимки со статусом `approved`, но этот адрес не вызывал ни один
 *     компонент; ни одна страница не читала `user_place_photos`, а герой
 *     карточки берёт фото из `ai_route_images`, куда одобрение ничего не
 *     копирует. Форма при этом обещала «Появятся после проверки модератором».
 *
 *  2. Без S3 файл не сохранялся вообще. Ветка «dev fallback» писала в базу
 *     выдуманный адрес, по которому нет роута, а байты не сохраняла никуда —
 *     и возвращала 201 «Фото отправлено». Турист получал зелёную галочку над
 *     потерянным снимком, админ модерировал пустоту.
 *
 * Оба — один и тот же отказ: место, где нельзя сказать «не могу», ответило
 * «хорошо» (CLAUDE.md 4.0). Сторож держит обе починки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const API = read('app/api/places/[id]/photos/route.ts');
const CARD = read('app/places/[id]/_PlaceDetailClient.tsx');
const BLOCK = read('components/places/PlaceUserPhotos.tsx');

/** Судим код, а не комментарии: разбор рядом с правкой вправе её называть. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const API_CODE = stripComments(API);
const CARD_CODE = stripComments(CARD);

describe('приём фото не рапортует об успехе без хранилища', () => {
  it('нет хранилища — отказ, а не запись в очередь', () => {
    const at = API_CODE.indexOf('if (!isS3Configured)');
    expect(at, 'проверка настроенности хранилища исчезла').toBeGreaterThan(0);
    const block = API_CODE.slice(at, at + 700);
    expect(block).toMatch(/status:\s*503/);
  });

  it('отказ наступает ДО вставки в user_place_photos', () => {
    const guardAt = API_CODE.indexOf('if (!isS3Configured)');
    const insertAt = API_CODE.indexOf('INSERT INTO user_place_photos');
    expect(insertAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(insertAt);
  });

  it('выдуманного адреса-заглушки больше нет', () => {
    // Именно он делал потерю файла неотличимой от успеха: строка в базе есть,
    // адрес выглядит правдоподобно, файла нет.
    expect(API_CODE).not.toMatch(/photos\/\$\{uid\}\$\{ext\}/);
    expect(API_CODE).not.toMatch(/Dev fallback/i);
  });

  it('отказ хранилища на загрузке тоже не превращается в «отправлено»', () => {
    // Ищем ВЫЗОВ, а не импорт: первое вхождение `uploadToS3` — строка импорта
    // в начале файла, и окно вокруг неё ничего о поведении не говорит.
    const at = API_CODE.indexOf('await uploadToS3(');
    expect(at, 'вызов загрузки в хранилище не найден').toBeGreaterThan(0);
    const around = API_CODE.slice(Math.max(0, at - 200), at + 600);
    expect(around).toMatch(/catch/);
    expect(around).toMatch(/status:\s*502/);
  });

  it('оба отказа пишутся в лог поимённо — «не смог» не молчит', () => {
    expect(API_CODE).toMatch(/console\.error\('\[places\/photos\]/);
  });
});

describe('одобренное фото доходит до карточки', () => {
  it('карточка места монтирует блок фото туристов', () => {
    expect(CARD_CODE).toContain('PlaceUserPhotos');
    expect(CARD_CODE).toMatch(/<PlaceUserPhotos placeId=\{place\.id\}/);
  });

  it('блок действительно спрашивает адрес одобренных фото', () => {
    // Без этого вызова путь снова обрывается на модерации — ровно тот дефект,
    // ради которого компонент заведён.
    expect(BLOCK).toMatch(/fetch\(`\/api\/places\/\$\{placeId\}\/photos`\)/);
  });

  it('у блока три исхода: есть фото, нет фото, не смогли спросить', () => {
    expect(BLOCK).toMatch(/kind:\s*'loading'/);
    expect(BLOCK).toMatch(/kind:\s*'ready'/);
    expect(BLOCK).toMatch(/kind:\s*'failed'/);
    // «Не смогли спросить» не рисуется как «фотографий нет»: блок молчит.
    expect(BLOCK).toMatch(/state\.kind !== 'ready' \|\| state\.photos\.length === 0/);
  });

  it('блок стоит перед формой загрузки — сначала видно, куда попадёт снимок', () => {
    const blockAt = CARD_CODE.indexOf('<PlaceUserPhotos');
    const uploadAt = CARD_CODE.indexOf('<PhotoUpload');
    expect(blockAt).toBeGreaterThan(0);
    expect(uploadAt).toBeGreaterThan(0);
    expect(blockAt).toBeLessThan(uploadAt);
  });
});
