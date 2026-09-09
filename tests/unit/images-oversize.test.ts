/**
 * tests/unit/images-oversize.test.ts
 *
 * Перепись тяжёлых снимков: только чтение, и она называет не вес, а судьбу.
 *
 * Сначала здесь стоял и сторож удаления по весу. Ответ самой переписи его
 * отменил: за порогом оказались `real-photo` — настоящие фотографии, одна из
 * них Халактырский пляж, видимое место с ЕДИНСТВЕННЫМ снимком (уникальный
 * индекс по route_id плюс `ON CONFLICT DO UPDATE` у обоих писателей — «другого
 * фото» не бывает). А настоящий вес, 197 МБ из 421, лежал в сгенерированных
 * картинках, куда порог по весу не дотягивается вовсе: у `pollinations-flux`
 * средний размер 99 КБ.
 *
 * Отсюда решение владельца 09.09 — реальные пережать, сгенерированные удалить
 * — и два отдельных разбора (`images-recompress`, `images-generated`), которые
 * стережёт tests/unit/images-repack.test.ts. Здесь остаётся охрана самой
 * переписи: она отвечает происхождением и тем, что исчезнет, и НЕ пишет.
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

describe('отказ не выдаётся за пустую партию', () => {
  const c = code(ROUTE);

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
  it('как ручной и ТОЛЬКО ЧИТАЮЩИЙ', () => {
    const reg = read('lib/agents/cron-schedulers.ts');
    expect(reg).toMatch(/'images-oversize':\s*\{ kind: 'manual', writes: false/);
  });

  it('в замороженном реестре возможностей — только чтение', () => {
    const caps = read('lib/agents/cron-capability-registry.ts');
    expect(caps).toMatch(/'images-oversize': \['db_read'\]/);
  });
});
