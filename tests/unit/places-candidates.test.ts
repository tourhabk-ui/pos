/**
 * Кандидаты в дубли по всему каталогу одним запросом.
 *
 * Разбор по виду за пробу — пятнадцать проб; этот роут отдаёт все пары сразу
 * с описаниями обеих сторон. Сторож держит три оплаченных урока: совпадение
 * типа, исключение плейсхолдер-координат из близости и вторую ветку по
 * похожести имён — без неё дубль с испорченной геопозицией невидим («Вулкан
 * Камень» в 457 км от «Камня» близостью не ловится).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/cron/places-candidates/route.ts'),
  'utf-8',
);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('только чтение под секретом', () => {
  it('ничего не пишет', () => {
    expect(CODE).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });
  it('закрыт CRON_SECRET', () => {
    expect(CODE).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });
});

describe('оплаченные уроки', () => {
  it('пара — только внутри одного типа', () => {
    // «Налычевская долина» и «Налычевские источники» стоят в одной точке,
    // но это разные объекты.
    expect(CODE).toMatch(/location_type IS NOT DISTINCT FROM p2\.location_type/);
  });

  it('плейсхолдер-координаты не участвуют в близости', () => {
    expect(CODE).toMatch(/53\.0444/);
    expect(CODE).toMatch(/lat = 0 AND .*\.lng = 0/);
  });

  it('есть ветка по похожести имён — ловит испорченную геопозицию', () => {
    expect(CODE).toMatch(/OR similarity\(p1\.name, p2\.name\) >= \$2/);
  });

  it('описания отдаются для обеих сторон пары', () => {
    // Решение «дубль или разные объекты» принимается по словам — без обоих
    // текстов пара возвращается на доследование отдельной пробой.
    expect(CODE).toMatch(/LEFT\(p1\.description, 140\) AS desc1/);
    expect(CODE).toMatch(/LEFT\(p2\.description, 140\) AS desc2/);
  });

  it('слитые записи не предлагаются снова', () => {
    expect(CODE).toMatch(/p1\.merged_into_id IS NULL AND p2\.merged_into_id IS NULL/);
  });
});
