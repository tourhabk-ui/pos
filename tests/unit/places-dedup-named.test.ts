/**
 * Слияние дублей мест выбирается парами, а не порогом.
 *
 * Прогон 71 дал десять кандидатов. Бесспорными оказались пары с похожестью
 * 1.00, 1.00, 1.00, 0.58 и 0.53; отклонены — 0.93 («Смотровая точка Б» и
 * «точка В»: буквы поставлены нарочно, это разные площадки), 0.82, 0.70, 0.63,
 * 0.50. Одобренное и отклонённое перемешаны по шкале — ни один порог не
 * выделяет нужное подмножество. Подогнать min_sim «чтобы совпало» значило бы
 * записать в код число без смысла, которое на следующих данных отберёт другое.
 *
 * Отсюда поимённый режим. Его главное свойство — не в том, что он сливает, а в
 * том, что он отказывается: плохая пара роняет весь запрос, а не выпадает из
 * него молча. Тихий пропуск вернул бы success на неполной работе — ровно та
 * подмена (отсутствие результата в форме результата), которая в этом проекте
 * уже стоила 63 часов слепого мониторинга.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pairListProblems } from '@/app/api/cron/places-dedup/route';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/cron/places-dedup/route.ts'),
  'utf-8'
);

const A = '630819da-48d1-4bb8-99c9-3b190d6ae26c';
const B = '8ef745b1-7de3-4899-9431-809f9c8521de';
const C = '3a98a68d-76c8-4835-8d6d-24f7dd867cb8';

describe('список пар проверяется до базы', () => {
  it('нормальный список проблем не имеет', () => {
    expect(pairListProblems([{ keep: A, merge: B }])).toEqual([]);
  });

  it('место не может быть и keep, и merge', () => {
    // A→B и B→C: судьба B зависела бы от порядка применения, а порядок здесь
    // ничем не задан.
    const p = pairListProblems([
      { keep: A, merge: B },
      { keep: B, merge: C },
    ]);
    expect(p.length).toBeGreaterThan(0);
    expect(p[0]).toContain(B);
  });

  it('слияние места в самого себя — описка, а не no-op', () => {
    expect(pairListProblems([{ keep: A, merge: A }])[0]).toContain(A);
  });
});

describe('отказ вместо частичной работы', () => {
  it('проблемная пара роняет весь запрос', () => {
    expect(SRC).toMatch(/не слито ничего/);
    expect(SRC).toMatch(/status: 400/);
  });

  it('неизвестный id — это проблема, а не пропуск', () => {
    // LEFT JOIN нужен именно затем, чтобы несуществующий id дал строку с NULL
    // и стал виден. INNER JOIN просто потерял бы пару.
    expect(SRC).toMatch(/LEFT JOIN places k/);
    expect(SRC).toMatch(/места с таким id нет/);
  });

  it('уже слитое место не сливается повторно', () => {
    expect(SRC).toMatch(/уже слито в другое место/);
  });
});

describe('поимённый режим не подменяет пороговый', () => {
  it('пороги при поимённом списке не применяются', () => {
    expect(SRC).toMatch(/data\.pairs\s*\n?\s*\?\s*await namedPlan/);
  });

  it('в ответе видно, каким путём получен план', () => {
    // Иначе «слито 5» одинаково выглядит и для выбора человеком, и для
    // случайного совпадения порогов.
    expect(SRC).toMatch(/mode: data\.pairs \? 'named' : 'thresholds'/);
  });

  it('сухой прогон остаётся значением по умолчанию', () => {
    expect(SRC).toMatch(/dry_run: z\.boolean\(\)\.default\(true\)/);
  });
});

describe('слияние остаётся мягким и обратимым', () => {
  it('пишется merged_into_id, а не DELETE FROM places', () => {
    // Миграция 172 физически удалила ~291 место без сохранения списка —
    // повторять это нечем.
    expect(SRC).toMatch(/UPDATE places SET merged_into_id/);
    expect(SRC).not.toMatch(/DELETE FROM places/);
  });

  it('применение одно на оба режима', () => {
    // Две копии применения разошлись бы, как уже расходились копии стиля линии
    // и сравнения секретов.
    expect(SRC.match(/UPDATE places SET merged_into_id/g)?.length).toBe(1);
    expect(SRC).toMatch(/async function applyPlan\(/);
  });
});
