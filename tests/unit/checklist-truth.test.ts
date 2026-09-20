/**
 * Чек-лист готовности отмечает сделанное, а не выбранное.
 *
 * Экран «Планирование» ведёт человека к выходу пятью пунктами. Два из них
 * говорили неправду, и оба — про то, чего не будет в поле, если связи нет:
 *
 *   1. «Маршрут сохранён офлайн» отмечался от `hasActiveRoute` — то есть от
 *      того, что маршрут ВЫБРАН. Ни одного скачанного байта за галочкой не
 *      стояло. Человек уходил, отметив себе, что всё взято.
 *   2. «Карты скачаны (450 МБ)» — число константой в подписи. Никто его не
 *      мерил, а настоящий вес лежит рядом, в записи о скачанном регионе.
 *
 * Чек-лист — последний экран перед местом без связи. Галочка здесь это не
 * украшение списка, а утверждение о том, что человек к этому месту готов.
 *
 * ── Вторая половина того же дефекта (20.09) ───────────────────────────────
 *
 * Первая починка заменила «маршрут выбран» на «запись о закачке есть» — и на
 * этом остановилась. Запись живёт в localStorage, тайлы в Cache Storage, и
 * система чистит второе, не трогая первое: запись пережила бы карту, а
 * галочка — обе. Свидетельством теперь служит проба Cache Storage
 * (`lib/offline/coverage.ts`), запись — только поводом её запросить.
 *
 * «Спросить нечем» (`cannot_check`: нет Cache Storage, старая запись без пробы)
 * галочкой не становится. Цена ошибки здесь односторонняя — уйти в поле без
 * карты, — поэтому непроверенность блокирует, а не успокаивает (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
/** Блок, где вычисляются автоматические галочки. */
const block = SRC.slice(SRC.indexOf('const effectiveChecklist'), SRC.indexOf('const effectiveChecklist') + 2600);

describe('офлайн-галочка стоит на свидетельстве', () => {
  it('блок автогалочек найден', () => {
    expect(block).toContain("item.id === 'offline'");
  });

  it('«сохранён офлайн» больше не выводится из факта выбора маршрута', () => {
    expect(block).not.toMatch(/id === 'offline'\)\s*return\s*\{\s*\.\.\.item,\s*done:\s*hasActiveRoute/);
  });

  it('запись о закачке больше не является свидетельством сама по себе', () => {
    // Прежнее правило: `done: savedRouteMap !== null`. Оно верило localStorage
    // о содержимом Cache Storage — разным хранилищам с разной судьбой.
    expect(block).not.toMatch(/id === 'offline'\)\s*return\s*\{\s*\.\.\.item,\s*done:\s*savedRouteMap\s*!==\s*null/);
  });

  it('свидетельство — подтверждённая проба Cache Storage', () => {
    expect(block).toMatch(/savedRouteCoverage/);
    expect(block).toMatch(/'covered'/);
  });

  it('«проверить нечем» галочкой не становится', () => {
    // Единственный путь к `done: true` — состояние `present`. Если появится
    // второй, этот тест обязан покраснеть: именно так галочка и вернулась бы
    // к утверждению непроверенного.
    const offline = block.slice(block.indexOf("item.id === 'offline'"));
    const tail = offline.slice(0, offline.indexOf('\n    }') + 6);
    expect(tail.match(/done:\s*true/g) ?? []).toHaveLength(1);
    expect(tail).toMatch(/st === 'covered'[\s\S]{0,80}done:\s*true/);
  });

  it('проба берётся из общего источника, а не считается на месте', () => {
    expect(SRC).toContain("from '@/lib/offline/coverage'");
    expect(SRC).toMatch(/probeCoverage\(rec\.sampleUrls\)/);
  });

  it('запись читается из хранилища по ключу маршрута, а не выдумывается', () => {
    expect(SRC).toMatch(/parseSavedMap\(localStorage\.getItem\(savedMapKey\(routeId\)\)\)/);
  });
});

describe('вес карт — измеренный, а не записанный в подпись', () => {
  it('в исходных подписях чек-листа нет числа мегабайт', () => {
    // Проверяется именно список подписей, а не весь файл: в комментариях
    // рядом объяснено, откуда взялась прежняя константа, и запрет по всему
    // файлу запрещал бы объяснение вместе с дефектом.
    const defaults = SRC.slice(SRC.indexOf('const DEFAULT_CHECKLIST'), SRC.indexOf('const DIFFICULTY_LABELS'));
    expect(defaults).not.toMatch(/label:\s*'[^']*\d+\s*МБ/);
  });

  it('число берётся из записи о регионе', () => {
    expect(block).toContain('regionMeta');
    expect(block).toMatch(/sizeBytes/);
  });

  it('без записи подпись остаётся без числа, а не с нулём', () => {
    // Ноль в мегабайтах читается как «бесплатно» — тот же дефект, что был на
    // кнопке «Сохранить карту · 0 МБ».
    expect(block).toMatch(/mb\s*\?\s*`[^`]*МБ`\s*:\s*'Карты региона скачаны'/);
  });
});
