// @vitest-environment node
/**
 * Волна 1 плана правок из аудита планировщика 07.11
 * (docs/audits/planner-audit-2026-11-07.md, раздел 5): что план говорит
 * читателю. Проверка — вызовом функций на данных, без моделей и базы.
 *
 * K1 — сборщик витрины перехватывал просьбу о плане: «составь план на 5 дней:
 *      рыбалка, вулкан, жильё и машина» отвечался списком жилья.
 * K2 — сверка цен вырезала строку сметы плана «Ориентир на человека», хотя её
 *      написал сам инструмент, и дописывала «цены нет в данных»; журнал плана
 *      обрезался до 2000 знаков, и строки сметы за обрезкой терялись.
 * K3 — сводка МЧС шла последней из важных строк «Важно» и уходила за потолок.
 * K4 — «зона не вошла» и допущение счёта у местного (уровень info) до агента
 *      не доходили вовсе. Теперь «зона не вошла» — в «Важно», допущение —
 *      сразу под сметой, к которой оно относится.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import {
  asksTripPlan, commercialSources, composeCommercial, dropUnsourcedPrices,
  type ComposeInput,
} from '@/lib/kuzmich/answer-quality';
import { journalToolOutput } from '@/lib/kuzmich/core';
import { planPriceLines, planWarningLines } from '@/lib/kuzmich/trip-plan-tool';

const NOTHING = { tours: false, transfers: false, stays: false, stayZones: [] };

describe('K1: просьба о плане — модели, не витрине', () => {
  const PLAN_ASKS = [
    'Составь план на 5 дней в июле 2027 для двоих: рыбалка, вулкан, жильё и машина',
    'Спланируй поездку на неделю, где остановиться?',
    'Что посмотреть за 5 дней на Камчатке?',
    'Рейс задержался на день, нужен трансфер — поправь план',
    'Нас теперь трое, пересобери план',
  ];

  it.each(PLAN_ASKS)('«%s» — витрина не читается и не отвечает', (q) => {
    expect(asksTripPlan(q)).toBe(true);
    expect(commercialSources(q)).toEqual(NOTHING);
    // До ввода витрины сборщик не доходит: вопрос о плане отсекается первым.
    expect(composeCommercial({ question: q } as unknown as ComposeInput)).toBeNull();
  });

  it('вопросы к витрине остаются витрине', () => {
    expect(asksTripPlan('Где остановиться в Паратунке?')).toBe(false);
    expect(commercialSources('Где остановиться в Паратунке?').stays).toBe(true);
    expect(asksTripPlan('Какие туры на вулканы есть осенью?')).toBe(false);
    expect(commercialSources('Какие туры на вулканы есть осенью?').tours).toBe(true);
    // «Что посмотреть» без срока поездки — по-прежнему витрина туров.
    expect(asksTripPlan('Что посмотреть в Петропавловске?')).toBe(false);
    expect(commercialSources('Что посмотреть в Петропавловске?').tours).toBe(true);
    // Срок жилья — не срок поездки: «на 2 ночи» витрину жилья не выключает.
    expect(asksTripPlan('Где жить в Елизово на 2 ночи?')).toBe(false);
    // Вопрос о маршруте без просьбы собрать план — не план поездки.
    expect(asksTripPlan('Какой маршрут на Авачинский самый простой?')).toBe(false);
  });
});

describe('K2: смета плана не вырезается, выдуманная вилка — вырезается', () => {
  const PLAN_OUTPUT = [
    'План на 5 дней (с 10 июля).',
    'День 2. Вулкан Горелый — тур «Горелый и пещеры», 10 000 ₽ за человека',
    'Ориентир на человека: 45 000 – 60 000 ₽ (уровень «Комфорт»). Из чего сложено:',
    'Итого на группу из 2 чел.: 90 000 – 120 000 ₽ — туры по своей цене, жильё — ориентир на каждого.',
  ].join('\n');

  it('строка сметы из вывода инструмента остаётся, ложной приписки нет', () => {
    const answer = 'Собрал план на 5 дней.\nОриентир на человека: 45 000 – 60 000 ₽.\nИтого на группу из 2 чел.: 90 000 – 120 000 ₽.';
    const r = dropUnsourcedPrices(answer, PLAN_OUTPUT);
    expect(r.dropped).toBe(false);
    expect(r.text).toContain('Ориентир на человека: 45 000 – 60 000 ₽');
    expect(r.text).not.toContain('не называю');
  });

  it('вилка, которой в источнике нет или которая сдвинута, — режется', () => {
    expect(dropUnsourcedPrices('Ориентир на человека: 50 000 – 70 000 ₽.', PLAN_OUTPUT).dropped).toBe(true);
    // Оба числа есть в источнике, но не этим диапазоном — это уже оценка модели.
    expect(dropUnsourcedPrices('Вилка: 45 000 – 120 000 ₽.', PLAN_OUTPUT).dropped).toBe(true);
    // «Ориентир» со знаком рубля, но без чисел из источника.
    expect(dropUnsourcedPrices('Ориентир — около 50 тыс. ₽.', PLAN_OUTPUT).dropped).toBe(true);
  });

  it('журнал хранит план целиком, а не 2000 знаков', () => {
    const long = `${'День N. Тур, программа дня. '.repeat(200)}\nОриентир на человека: 45 000 – 60 000 ₽`;
    expect(long.length).toBeGreaterThan(5000);
    expect(journalToolOutput('make_trip_plan', long)).toBe(long);
    expect(journalToolOutput('edit_trip_plan', long)).toBe(long);
    // Прочие инструменты — со своим потолком, как прежде.
    expect(journalToolOutput('search_accommodations', long).length).toBe(2000);
    expect(journalToolOutput('get_weather', `${long}${'x'.repeat(8000)}`).length).toBe(12_000);
  });
});

describe('K3, K4: «Важно» у агента — сводка МЧС впереди, причины зоны доходят', () => {
  type W = { type: string; severity: 'critical' | 'important' | 'info'; message: string };
  const filler = (n: number): W[] => Array.from({ length: n }, (_, i) => ({ type: 'fitness', severity: 'important', message: `подготовка ${i + 1}` }));

  it('сводка МЧС, добавленная движком последней, встаёт сразу за критическим', () => {
    const lines = planWarningLines({
      warnings: [
        ...filler(9),
        { type: 'season', severity: 'critical', message: 'Рыбалка: недоступно в выбранный период' },
        { type: 'mchs', severity: 'important', message: 'МЧС: извержение вулкана Шивелуч, подход закрыт' },
      ],
      preferences: null,
    });
    expect(lines[0]).toBe('Рыбалка: недоступно в выбранный период');
    expect(lines[1]).toBe('МЧС: извержение вулкана Шивелуч, подход закрыт');
  });

  it('«зона не вошла» доходит и уровнем info; загрузка, чужие разрешения и допущение счёта в «Важно» — нет', () => {
    const lines = planWarningLines({
      warnings: [
        { type: 'crowd', severity: 'info', message: 'Умеренная загрузка' },
        { type: 'permit', severity: 'info', message: 'Разрешения для зон вне плана' },
        { type: 'zone_days', severity: 'info', message: 'Западная зона в план не вошла: на неё нужно 3 дня' },
        { type: 'home_nights', severity: 'info', message: 'Ночи дома в счёт не вошли' },
        { type: 'safety', severity: 'info', message: 'Территория медведей' },
      ],
      preferences: { notes: [{ status: 'partial', message: 'Дни отдыха: один из двух' }] },
    });
    expect(lines).toEqual([
      'Дни отдыха: один из двух',
      'Западная зона в план не вошла: на неё нужно 3 дня',
      'Территория медведей',
    ]);
  });

  it('допущение счёта у местного — сразу под сметой, потолок «Важно» его не режет', () => {
    const smeta = ['Ориентир на человека: 45 000 – 60 000 ₽ (уровень «Комфорт»). Из чего сложено:', '- жильё: 10 000 – 20 000 ₽'];
    const warnings = [
      ...filler(12),
      { type: 'home_nights', severity: 'info' as const, message: 'Ночи дома в счёт не вошли' },
    ];
    expect(planPriceLines(smeta, warnings)).toEqual([...smeta, 'Ночи дома в счёт не вошли']);
    // Не местный — допущения нет; сметы нет — нечего и уточнять.
    expect(planPriceLines(smeta, filler(2))).toEqual(smeta);
    expect(planPriceLines([], warnings)).toEqual([]);
  });
});
