/**
 * Полевая проверка — форма и приём (владелец 21.08).
 *
 * Три черты, ради которых это делалось, и которые нельзя потерять:
 *  1. Проверка НЕ меняет данные — только очередь со статусом pending.
 *  2. Третье состояние: координата и точность необязательны, «не с места» —
 *     законное состояние; половина координаты не принимается.
 *  3. Офлайн не теряет улику: неотправленное лежит на диске и уходит само.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const report = readFileSync(join(process.cwd(), 'app/api/field-check/report/route.ts'), 'utf-8');
const nearby = readFileSync(join(process.cwd(), 'app/api/field-check/nearby/route.ts'), 'utf-8');
const client = readFileSync(join(process.cwd(), 'app/field-check/_FieldCheckClient.tsx'), 'utf-8');
const migration = readFileSync(join(process.cwd(), 'migrations/898_route_field_checks.sql'), 'utf-8');

describe('приём проверки — очередь, а не правка', () => {
  it('пишет только в route_field_checks', () => {
    expect(report).toContain('INSERT INTO route_field_checks');
    expect(report).not.toMatch(/UPDATE kamchatka_routes|UPDATE places/);
  });

  it('статус по умолчанию — pending, решает человек', () => {
    expect(migration).toMatch(/status[\s\S]{0,80}DEFAULT 'pending'/);
  });

  it('вход валидируется Zod и параметризован', () => {
    expect(report).toContain('BodySchema.parse');
    expect(report).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\)/);
  });

  it('половина координаты не принимается', () => {
    expect(report).toMatch(/hasLat !== hasLng/);
  });

  it('координата и точность допускают отсутствие', () => {
    expect(report).toMatch(/reported_lat: z\.number\(\)[\s\S]{0,60}\.nullable\(\)/);
    expect(report).toMatch(/accuracy_m: z\.number\(\)[\s\S]{0,80}\.nullable\(\)/);
    expect(migration).toMatch(/accuracy_m\s+INTEGER CHECK \(accuracy_m IS NULL/);
  });
});

describe('выборка рядом — только живые записи', () => {
  it('скрытые и слитые не показываются', () => {
    expect(nearby).toMatch(/p\.is_visible = true AND p\.merged_into_id IS NULL/);
    expect(nearby).toMatch(/r\.is_visible = true AND r\.merged_into_id IS NULL/);
  });

  it('незнание показывается словами, а не нулём', () => {
    expect(client).toContain("f.value ?? 'не знаем'");
  });
});

describe('офлайн не теряет улику', () => {
  it('очередь на диске и отправка при возврате связи', () => {
    // Очередь переехала в IndexedDB, когда к проверке добавились снимки:
    // в пятимегабайтный localStorage помещалось три фотографии, а выход в
    // поле — это десятки проверок.
    expect(client).toContain('listFieldChecks');
    expect(client).toMatch(/addEventListener\('online'/);
  });

  it('неотправленное видно человеку', () => {
    expect(client).toMatch(/Не отправлено: \{queueLen\}/);
  });
});

describe('PWA и фотографии', () => {
  const sw = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf-8');
  const photo = readFileSync(join(process.cwd(), 'app/api/field-check/photo/route.ts'), 'utf-8');
  const db = readFileSync(join(process.cwd(), 'lib/offline/db.ts'), 'utf-8');

  it('форма прекэшируется — её открывают там, где связи нет', () => {
    expect(sw).toContain("'/field-check'");
  });

  it('версия кэша поднята вместе с составом прекэша', () => {
    expect(sw).toMatch(/CACHE_NAME = 'kamchatour-v27'/);
  });

  it('форма регистрирует service worker сама', () => {
    expect(client).toMatch(/serviceWorker\.register\('\/sw\.js'\)/);
  });

  it('снимок сжимается на телефоне, а не отправляется оригиналом', () => {
    expect(client).toContain('PHOTO_MAX_SIDE');
    expect(client).toMatch(/toDataURL\('image\/jpeg', PHOTO_QUALITY\)/);
  });

  it('очередь с фотографиями живёт в IndexedDB, не в localStorage', () => {
    expect(client).toContain('queueFieldCheck');
    expect(client).not.toContain('field_check_queue_v1');
    expect(db).toMatch(/fieldChecks/);
    expect(db).toMatch(/DB_VERSION = 4/);
  });

  it('снимок принимается отдельно и с потолком размера', () => {
    expect(photo).toContain('MAX_BYTES');
    expect(photo).toContain('INSERT INTO route_field_check_photos');
    expect(photo).not.toMatch(/UPDATE kamchatka_routes|UPDATE places/);
  });

  it('запись удаляется из очереди только после успеха', () => {
    expect(client).toMatch(/if \(!res\.ok\) break;[\s\S]{0,900}deleteFieldCheck\(item\.id\)/);
  });
});
