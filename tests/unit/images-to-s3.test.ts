/**
 * tests/unit/images-to-s3.test.ts
 *
 * Снимки мест переезжают из базы в S3 — и не теряются по дороге.
 *
 * Замер 08.09 (`db-size-census`, prod-check run 42): база 839,9 МБ, и больше
 * ПОЛОВИНЫ этого — одна таблица `ai_route_images`: 439,6 МБ на 657 строк,
 * ~670 КБ на снимок, `image_data BYTEA` прямо в PostgreSQL. Рядом стоит S3 на
 * 100 ГБ — оплаченный, подключённый, уже используемый. Комментарий миграции
 * 107, заведшей таблицу: «TEMPORARY until real photos are uploaded».
 *
 * Опасность переезда в одном: заливка вернула успех, объект недоступен, байты
 * стёрты. «Переехало» и «потеряно» выглядят одинаково, и узнаётся разница с
 * чужого экрана, когда восстанавливать уже нечего. Поэтому сторож держит
 * ПОРЯДОК ДЕЙСТВИЙ, а не только факт переноса.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const MOVER    = read('app/api/cron/images-to-s3/route.ts');
const SERVE    = read('app/api/images/route/[routeId]/route.ts');
const MIGRATION = read('migrations/944_ai_route_images_s3.sql');

/** Код без комментариев: судим употребление, а не рассказ о нём. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('байты не удаляются раньше проверки', () => {
  const c = code(MOVER);

  it('объект читается обратно ДО обнуления image_data', () => {
    const readBack = c.indexOf('await fetch(uploaded.url');
    const nulling  = c.indexOf('image_data = NULL');
    expect(readBack, 'чтения обратно нет вовсе').toBeGreaterThan(0);
    expect(nulling, 'обнуления нет — переезд не освобождает место').toBeGreaterThan(0);
    expect(readBack, 'байты стираются раньше проверки').toBeLessThan(nulling);
  });

  it('сверяется размер, а не только код ответа', () => {
    // HTTP 200 с пустым телом — тоже «успех». Размер отличает доехавший
    // объект от доехавшего ответа.
    expect(c).toMatch(/readBack\.length !== r\.image_data\.length/);
  });

  it('не сошлось — строка остаётся, и это попадает в отчёт', () => {
    expect(c).toMatch(/failed\.push/);
    expect(c).toMatch(/failed_count/);
    // continue, а не тихий пропуск: строка не должна уйти в moved.
    expect(c).toMatch(/размер не сошёлся/);
  });
});

describe('правила пишущей партии соблюдены', () => {
  const c = code(MOVER);

  it('сухой прогон по умолчанию', () => {
    expect(c).toMatch(/dry_run:\s*z\.boolean\(\)\.default\(true\)/);
  });

  it('причина обязательна и без умолчания', () => {
    expect(c).toMatch(/reason:\s*z\.string\(\)\.min\(/);
    expect(c).not.toMatch(/reason:[^\n]*default\(/);
  });

  it('партия не больше десяти', () => {
    expect(c).toMatch(/MAX_BATCH = 10/);
    expect(c).toMatch(/\.max\(MAX_BATCH\)/);
  });

  it('идемпотентность: берутся только непереехавшие', () => {
    expect(c).toMatch(/s3_key IS NULL AND image_data IS NOT NULL/);
    // Запись тоже под условием — параллельный прогон не перепишет чужую строку.
    expect(c).toMatch(/WHERE id = \$3::uuid AND s3_key IS NULL/);
  });

  it('закрыт CRON_SECRET со сверкой по времени', () => {
    expect(c).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });
});

describe('отдача снимка переживает переезд', () => {
  const c = code(SERVE);

  it('есть ссылка — отдаём ссылкой, нет — байтами, нет ничего — 404', () => {
    expect(c).toMatch(/row\?\.s3_url/);
    expect(c).toMatch(/row\?\.image_data/);
    expect(c).toMatch(/'Not found', \{ status: 404 \}/);
  });

  it('ссылка проверяется раньше байтов — иначе переезд не разгружает базу', () => {
    expect(c.indexOf('row?.s3_url')).toBeLessThan(c.indexOf('row?.image_data'));
  });

  it('отказ хранилища по-прежнему 503 с записью в лог, а не «картинки нет»', () => {
    expect(c).toMatch(/status: 503/);
    expect(c).toMatch(/console\.error\('\[images\]/);
  });
});

describe('миграция освобождает место, но ничего не переносит', () => {
  it('колонки заведены идемпотентно', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS s3_key/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS s3_url/);
  });

  it('строка без байтов становится законной', () => {
    // Без этого переехавшая строка не сохранится: NOT NULL не даст обнулить.
    expect(MIGRATION).toMatch(/ALTER COLUMN image_data DROP NOT NULL/);
  });

  it('данные миграция не трогает: перенос — работа партиями', () => {
    expect(MIGRATION).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
  });
});

describe('перевозчик объявлен', () => {
  it('в реестре планировщиков как ручной и ПИШУЩИЙ', () => {
    const reg = read('lib/agents/cron-schedulers.ts');
    expect(reg).toMatch(/'images-to-s3':\s*\{ kind: 'manual', writes: true/);
  });

  it('в замороженном реестре возможностей — с записью и выходом в сеть', () => {
    const caps = read('lib/agents/cron-capability-registry.ts');
    expect(caps).toMatch(/'images-to-s3': \['db_read', 'db_write', 'net_out'\]/);
  });
});
