/**
 * tests/unit/images-oversize.test.ts
 *
 * Удаление снимка необратимо, и сторож держит то, что делает его безопасным.
 *
 * Сухой прогон переезда в S3 (prod-check run 43) показал перекос: первые два
 * снимка по 15,4 МБ при среднем по таблице 641 КБ. Решение владельца — такие
 * удалять. Опасность в том, что у места снимок РОВНО ОДИН: уникальный индекс
 * по route_id (миграция 107) плюс `ON CONFLICT (route_id) DO UPDATE` у обоих
 * писателей. Удалённую строку восстановить неоткуда, «другого фото» не бывает.
 *
 * Отсюда предмет охраны: порог называет человек, причина обязательна, сухой
 * прогон по умолчанию, а перепись говорит не только вес, но и что исчезнет.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const ROUTE = read('app/api/cron/images-oversize/route.ts');

/** Код без комментариев: судим употребление, а не рассказ о нём. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('порог удаления называет человек, а не код', () => {
  const c = code(ROUTE);

  it('min_bytes обязателен и БЕЗ умолчания', () => {
    // Умолчание здесь — выдуманная граница: строки по обе её стороны
    // различаются судьбой, а решение никто не принимал (§4.0).
    expect(c).toMatch(/min_bytes:\s*z\.number\(\)\.int\(\)\.min\(1/);
    expect(c).not.toMatch(/min_bytes:[^\n]*\.default\(/);
  });

  it('причина обязательна и без умолчания', () => {
    expect(c).toMatch(/reason:\s*z\.string\(\)\.min\(/);
    expect(c).not.toMatch(/reason:[^\n]*\.default\(/);
  });

  it('сухой прогон по умолчанию, партия не больше десяти', () => {
    expect(c).toMatch(/dry_run:\s*z\.boolean\(\)\.default\(true\)/);
    expect(c).toMatch(/MAX_BATCH = 10/);
    expect(c).toMatch(/\.max\(MAX_BATCH\)/);
  });
});

describe('GET не удаляет, POST удаляет', () => {
  const c = code(ROUTE);

  it('DELETE есть только в POST', () => {
    const get  = c.indexOf('export async function GET');
    const post = c.indexOf('export async function POST');
    const del  = c.indexOf('DELETE FROM ai_route_images');
    expect(get).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(get);
    expect(del, 'удаления нет вовсе').toBeGreaterThan(post);
  });

  it('порог повторён в самом DELETE, а не только в выборке', () => {
    // Между переписью и удалением снимок мог быть заменён лёгким через
    // админку. Без повторного условия удалился бы уже другой файл.
    expect(c).toMatch(/DELETE FROM ai_route_images[\s\S]{0,200}OCTET_LENGTH\(image_data\) >= \$2/);
  });
});

describe('перепись говорит, что именно исчезнет', () => {
  const c = code(ROUTE);

  it('происхождение снимка (model) — в ответе', () => {
    // Оба живых писателя режут файл через sharp до 1280x720. Пятнадцать
    // мегабайт с этого конвейера выйти не могут, и model отвечает, откуда
    // строка взялась на самом деле.
    expect(c).toMatch(/by_model/);
    expect(c).toMatch(/GROUP BY model/);
  });

  it('имя места и его видимость, а не только UUID', () => {
    expect(c).toMatch(/subject_name/);
    expect(c).toMatch(/subject_visible/);
  });

  it('снимок без места и маршрута назван сиротой, а не «скрытым»', () => {
    expect(c).toMatch(/'orphan'/);
  });

  it('кредит автора отличает фотографию от картинки', () => {
    expect(c).toMatch(/credited/);
  });
});

describe('обещания соразмерны тому, что делает DELETE', () => {
  it('сказано, что файл на диске не уменьшится', () => {
    // Ожидание «удалим и база похудеет» неверно: DELETE освобождает страницы
    // под будущие строки этой же таблицы, pg_database_size не падает.
    expect(ROUTE).toMatch(/VACUUM FULL/);
    expect(code(ROUTE)).toMatch(/space_note/);
  });

  it('сказано, что снимок у места один и заменить его нечем', () => {
    expect(code(ROUTE)).toMatch(/cost_note/);
    expect(ROUTE).toMatch(/уникальный индекс/);
  });
});

describe('отказ не выдаётся за пустую партию', () => {
  const c = code(ROUTE);

  it('несработавшее удаление попадает в failed с причиной', () => {
    expect(c).toMatch(/failed\.push/);
    expect(c).toMatch(/failed_count/);
  });

  it('отказ переписи — 503 с SQLSTATE, а не пустой список', () => {
    expect(c).toMatch(/status: 503/);
    expect(c).toMatch(/sqlstate: code/);
    expect(c).toMatch(/meaningful:/);
  });

  it('закрыт CRON_SECRET со сверкой по времени', () => {
    expect(c).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });
});

describe('роут объявлен в обоих реестрах', () => {
  it('как ручной и пишущий', () => {
    const reg = read('lib/agents/cron-schedulers.ts');
    expect(reg).toMatch(/'images-oversize':\s*\{ kind: 'manual', writes: true/);
  });

  it('с записью в базу и БЕЗ выхода в сеть', () => {
    const caps = read('lib/agents/cron-capability-registry.ts');
    expect(caps).toMatch(/'images-oversize': \['db_read', 'db_write'\]/);
  });
});
