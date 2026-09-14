/**
 * #1883: Кузьмич выдумывал километраж «от Петропавловска» два прогона евала
 * подряд (13.09 pass_rate 0.60, 14.09 pass_rate 0.75) — промпт запрещает это
 * прямо и не помогает. Guard ловит незаземлённый километраж детерминированно,
 * по образцу lib/safety/sos-detector.ts.
 *
 * Тексты в первых трёх тестах — дословные ответы Кузьмича из прогонов евала
 * (см. issue #1883), контекст — минимальный, без совпадающих чисел, как было
 * в реальных прогонах.
 */
import { describe, it, expect } from 'vitest';
import { stripUngroundedDistanceClaims } from '@/lib/kuzmich/distance-guard';

const NO_DISTANCE_CONTEXT = '=== Маршруты по запросу ===\nМаршрут: Паратунские источники\nТермальные источники, купание круглый год.';

describe('живые провалы евала (#1883)', () => {
  it('Паратунка: выдуманные 60 км и дорога через Елизово вырезаны', () => {
    const answer =
      'От Петропавловска-Камчатского до Паратунки примерно 60 километров. ' +
      'Дорога идёт через Елизово, обычно занимает около часа на машине.\n\n' +
      'Кстати, Паратунка — это в первую очередь термальные источники, купаться там можно круглый год. ' +
      'Интересует что-то из этого — источники, базы отдыха или просто дорога?';
    const { cleaned, removed } = stripUngroundedDistanceClaims(answer, NO_DISTANCE_CONTEXT);

    expect(cleaned).not.toContain('60 километров');
    expect(cleaned).not.toContain('через Елизово');
    expect(cleaned).toContain('Точных данных о расстоянии');
    // Второй абзац — легитимный, не про километраж — остаётся как был.
    expect(cleaned).toContain('термальные источники, купаться там можно круглый год');
    expect(cleaned).toContain('\n\n'); // структура абзацев сохранена
    expect(removed.length).toBe(2);
  });

  it('Малкинские источники: выдуманные 200 км и маршрут через Елизово и Сокоч вырезаны', () => {
    const answer =
      'Малкинские источники — примерно 200 км от Петропавловска-Камчатского. ' +
      'Дорога идёт через Елизово и Сокоч, обычно это 3–4 часа на машине в зависимости от состояния трассы.\n\n' +
      'Кстати, рядом с Малками течёт река Быстрая — там как раз проходит однодневный сплав с ухой.';
    const { cleaned, removed } = stripUngroundedDistanceClaims(answer, NO_DISTANCE_CONTEXT);

    expect(cleaned).not.toContain('200 км');
    expect(cleaned).not.toContain('Елизово и Сокоч');
    expect(cleaned).toContain('Точных данных о расстоянии');
    expect(cleaned).toContain('река Быстрая');
    expect(removed.length).toBe(2);
  });

  it('Курильское озеро: выдуманные 400 км вырезаны, а грамотный контекст соседних предложений остаётся', () => {
    const answer =
      'Дорога к озеру идёт через Вилючинский перевал, а проезд там с 15 июля только по пропускам.\n\n' +
      'По расстоянию: от Петропавловска-Камчатского до Курильского озера около 400 км. ' +
      'Значительная часть пути грунтовая.\n\n' +
      'Тебя интересует именно дорога на машине или рассматриваешь вертолётный тур?';
    const { cleaned, removed } = stripUngroundedDistanceClaims(answer, NO_DISTANCE_CONTEXT);

    expect(cleaned).not.toContain('400 км');
    expect(cleaned).toContain('Точных данных о расстоянии');
    // Первый абзац (про пропуска на перевале) — отдельный, не про километраж, не тронут.
    expect(cleaned).toContain('только по пропускам');
    expect(cleaned).toContain('вертолётный тур');
    expect(removed.length).toBeGreaterThanOrEqual(1);
  });
});

describe('не режет то, что заземлено или не относится к делу', () => {
  it('число подтверждено контекстом — предложение остаётся как есть', () => {
    const context = 'Расстояние от Петропавловска-Камчатского до Паратунки — 60 км (данные оператора).';
    const answer = 'От Петропавловска-Камчатского до Паратунки примерно 60 километров.';
    const { cleaned, removed } = stripUngroundedDistanceClaims(answer, context);
    expect(cleaned).toBe(answer);
    expect(removed).toEqual([]);
  });

  it('длина самого маршрута (routeFacts) не путается с расстоянием от города', () => {
    // routeFacts() печатает "дистанция N км" без слова "Петропавловск"/"города" рядом.
    const answer = 'Маршрут: Авачинский вулкан\nдистанция 6 км · набор высоты 1200 м · сложность средняя';
    const { cleaned, removed } = stripUngroundedDistanceClaims(answer, '');
    expect(cleaned).toBe(answer);
    expect(removed).toEqual([]);
  });

  it('ответ без километража не трогается вовсе', () => {
    const answer = 'Авачинский вулкан сейчас в красном статусе — восхождение не рекомендуется.';
    const { cleaned, removed } = stripUngroundedDistanceClaims(answer, '');
    expect(cleaned).toBe(answer);
    expect(removed).toEqual([]);
  });

  it('километраж без упоминания города — не тот класс, не трогается', () => {
    const answer = 'Маршрут длиной 12 км подойдёт для однодневного похода.';
    const { cleaned, removed } = stripUngroundedDistanceClaims(answer, '');
    expect(cleaned).toBe(answer);
    expect(removed).toEqual([]);
  });

  it('два независимых незаземлённых упоминания в одном абзаце — одна честная фраза, не две подряд', () => {
    const answer =
      'До Паратунки от Петропавловска примерно 60 км. ' +
      'А до Малков от Петропавловска все 200 км.';
    const { cleaned } = stripUngroundedDistanceClaims(answer, '');
    const occurrences = cleaned.split('Точных данных о расстоянии').length - 1;
    expect(occurrences).toBe(1);
  });
});
