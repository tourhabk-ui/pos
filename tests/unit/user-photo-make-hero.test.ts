/**
 * Снимок туриста можно сделать главным фото карточки (владелец 14.09:
 * «давай-ка это разрешим»).
 *
 * ПОЧЕМУ РАЗДЕЛЕНИЕ БЫЛО. Фото туриста и фото каталога — разные по
 * происхождению вещи, и смешивать их в одной галерее значит выдавать
 * любительский кадр за карточный. Это решение остаётся: снимок не становится
 * героем САМ, по факту одобрения.
 *
 * ЧЕМ ОНО БЫЛО ПЛОХО. Оно не оставляло ВЫБОРА. Даже владелец, снявший место
 * лично, не мог поставить свой кадр на карточку иначе как загрузив тот же
 * файл второй раз — уже через админку места. Правило, у которого нет
 * исключения даже для того, кто его установил, — не правило, а тупик.
 *
 * Теперь это ЯВНОЕ действие человека (`make_hero`), а не следствие
 * модерации.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const ROUTE = read('app/api/admin/user-photos/[id]/route.ts');
const VIEW = read('components/places/PlaceUserPhotos.tsx');

describe('make_hero — действие, а не побочный эффект модерации', () => {
  it('третье действие рядом с approve/reject, не вместо них', () => {
    expect(ROUTE).toMatch(/action: z\.enum\(\['approve', 'reject', 'make_hero'\]\)/);
  });

  it('только админ: роут остаётся за requireAdmin', () => {
    expect(ROUTE).toMatch(/const adminOrResponse = await requireAdmin\(request\)/);
  });

  it('переносится ССЫЛКА, а не байты', () => {
    // У ai_route_images есть s3_url, и раздача отдаёт его редиректом.
    // Копировать мегабайты ради смены главного фото незачем.
    const at = ROUTE.indexOf('INSERT INTO ai_route_images');
    expect(at).toBeGreaterThan(-1);
    const stmt = ROUTE.slice(at, ROUTE.indexOf('`,', at));
    expect(stmt).toContain('s3_url');
    expect(stmt).toMatch(/image_data\s*=\s*NULL/);
  });

  it('права переписываются целиком — прежний герой не оставляет подписи', () => {
    const at = ROUTE.indexOf('ON CONFLICT (route_id) DO UPDATE');
    const upd = ROUTE.slice(at, ROUTE.indexOf('`,', at));
    for (const c of ['author', 'license', 'license_url', 'source_url']) {
      expect(upd, c).toMatch(new RegExp(`${c}\\s*=\\s*EXCLUDED\\.${c}`));
    }
  });

  it('одобрение идёт вместе с переносом, а не отдельным шагом', () => {
    // «Фото на карточке, но ждёт проверки» — противоречие; два действия
    // подряд оставили бы окно, в котором оно истинно.
    expect(ROUTE).toMatch(/UPDATE user_place_photos\s*\n\s*SET status = 'approved'/);
  });
});

describe('имя чужого человека не публикуется умолчанием', () => {
  it('свой снимок подписывается своим именем, чужой — только явным author', () => {
    expect(ROUTE).toMatch(/const isOwnPhoto = row\.user_id === admin\.userId/);
    expect(ROUTE).toMatch(/authorOverride \?\? \(isOwnPhoto \? row\.uploader_name : null\)/);
  });

  it('без подписи чужого снимка — отказ словами, а не тихая публикация', () => {
    expect(ROUTE).toMatch(/Это снимок другого человека/);
    expect(ROUTE).toMatch(/status: 400/);
  });
});

describe('кнопка на карточке', () => {
  it('показывается только админу, и право всё равно проверяет сервер', () => {
    expect(VIEW).toMatch(/\{isAdmin === true && \(/);
    // Три состояния: «да», «нет», «пока не знаю» — последнее не равно первому,
    // иначе кнопка мигала бы на медленной сети.
    expect(VIEW).toMatch(/useState<boolean \| null>\(null\)/);
  });

  it('роль берётся АКТИВНАЯ — та же, по которой судит requireAdmin', () => {
    expect(VIEW).toMatch(/json\?\.data\?\.role === 'admin'/);
  });

  it('исход называется словами в обоих случаях', () => {
    expect(VIEW).toMatch(/Готово — фото стало главным/);
    expect(VIEW).toMatch(/json\.error \?\? 'Не удалось сделать фото главным'/);
    expect(VIEW).toMatch(/Нет связи/);
  });
});
