/**
 * У места может быть больше одной фотографии — по КАЖДОМУ пути загрузки.
 *
 * ── Что спросил владелец (15.09) ──────────────────────────────────────────
 *
 * «Почему в месте только одна фотография? Сложно судить о месте по одному
 * фото».
 *
 * Механизм галереи существует с 14.09 (`place_gallery_photos`, миграция
 * 968), и ручная загрузка из админки с того же дня кладёт второй снимок
 * туда. Но второй путь — фото с Wikimedia Commons — остался прежним:
 * поиск отдаёт до ДВЕНАДЦАТИ кандидатов, а сохранялся ровно один.
 * `ON CONFLICT (route_id) DO UPDATE` переписывал прежний, то есть каждый
 * следующий выбранный кадр СТИРАЛ предыдущий. Больше одной фотографии у
 * места не могло появиться в принципе, сколько ни выбирай.
 *
 * ── Правило одно на оба пути ──────────────────────────────────────────────
 *
 * Нет главного — снимок идёт главным; главное есть — снимок идёт в галерею;
 * замену надо сказать вслух. Два разных правила для двух путей разошлись бы
 * при первой же правке — это уже случалось с шириной карточки (девятнадцать
 * мест) и со стандартом линии (три экрана).
 *
 * Права при этом едут с каждым снимком: у CC-BY указание автора обязательно,
 * и колонки author/license/license_url/source_url есть у обеих таблиц.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const WIKI = read('app/api/admin/places/[id]/wiki-candidates/route.ts');
const UPLOAD = read('app/api/admin/places/[id]/photo/route.ts');
const ADMIN_UI = read('app/hub/admin/places-photos/_PlacesPhotosClient.tsx');

describe('оба пути загрузки кладут второй снимок в галерею', () => {
  it('вики-путь пишет в place_gallery_photos', () => {
    expect(WIKI).toMatch(/INSERT INTO place_gallery_photos/);
  });

  it('ручная загрузка пишет туда же', () => {
    expect(UPLOAD).toMatch(/INSERT INTO place_gallery_photos/);
  });

  it('оба решают по наличию главного, а не по догадке', () => {
    for (const [name, src] of [['вики', WIKI], ['ручная', UPLOAD]] as const) {
      expect(src, `${name}: нет проверки главного фото`)
        .toMatch(/FROM ai_route_images WHERE route_id = \$1/);
      expect(src, `${name}: нет ветки «главное есть»`).toMatch(/hasHero &&/);
    }
  });

  it('замена главного требует явного слова', () => {
    expect(WIKI).toMatch(/replaceHero/);
    expect(UPLOAD).toMatch(/replace_hero/);
  });

  it('позиция считается отдельным запросом, а не INSERT ... SELECT MAX', () => {
    // 42P08: у той формы параметрам негде взять якорь типа, и она не
    // выполняется НИКОГДА (§4, случай 24.08).
    expect(WIKI).not.toMatch(/INSERT INTO place_gallery_photos[\s\S]{0,400}SELECT/);
    expect(WIKI).toMatch(/SELECT COALESCE\(MAX\(position\), 0\) \+ 1/);
  });

  it('права едут со снимком галереи', () => {
    // CC-BY требует видимого указания автора; снимок без прав подписывать
    // нечем, а приписывать чужое имя нельзя (правка 14.09).
    const at = WIKI.indexOf('INSERT INTO place_gallery_photos');
    const stmt = WIKI.slice(at, at + 500);
    for (const col of ['author', 'license', 'license_url', 'source_url']) {
      expect(stmt, `в галерею не едет ${col}`).toContain(col);
    }
  });

  it('отказ записи не выдаётся за успех', () => {
    expect(WIKI).toMatch(/console\.error\('\[wiki-photo\]/);
    expect(WIKI).toMatch(/status: 503/);
  });
});

describe('админка даёт взять несколько кадров подряд', () => {
  it('окно выбора не закрывается на снимке галереи', () => {
    // Закрытие после первого снова оставило бы место с одной фотографией —
    // ровно то, о чём и был вопрос.
    expect(ADMIN_UI).toMatch(/if \(data\.slot !== 'gallery'\) setWikiDone\(true\)/);
  });

  it('обложка списка меняется только при смене главного', () => {
    expect(ADMIN_UI).toMatch(/data\.slot !== 'gallery'/);
  });

  it('человек видит, куда лёг снимок', () => {
    expect(ADMIN_UI).toMatch(/Добавлено в галерею/);
  });
});
