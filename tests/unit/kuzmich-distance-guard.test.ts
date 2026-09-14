/**
 * Неподтверждённый километраж помечается вслух (#1883, вариант Б владельца).
 *
 * Кузьмич отвечал «до Паратунки примерно 60 км», «Малкинские — примерно
 * 200 км», «до Курильского около 400 км» — ни одного из этих чисел в данных
 * платформы нет. Промпт это ЗАПРЕЩАЕТ прямо и всё равно нарушается на трёх
 * вопросах из трёх в двух прогонах подряд: значит строкой в промпте не
 * чинится, нужен серверный guard (§8, тот же вывод, что у sos-detector).
 *
 * ГЛАВНОЕ РЕШЕНИЕ, КОТОРОЕ ДЕРЖИТ ЭТОТ СТОРОЖ: судим по ИСТОЧНИКУ, а не по
 * правде. В том же прогоне «около 25 км до Авачинского» было ВЕРНО — и всё
 * равно неподтверждено. Верное число остаётся в ответе и получает пометку:
 * для туриста подтверждённое и угаданное неотличимы, а следующее угаданное
 * окажется неверным.
 */
import { describe, it, expect } from 'vitest';
import {
  findDistanceClaims, unsourcedClaims, withDistanceCaveat, DISTANCE_CAVEAT,
} from '@/lib/kuzmich/distance-guard';

describe('что считается названным расстоянием', () => {
  it('километры во всех виданных формах', () => {
    const claims = findDistanceClaims('примерно 60 км, около 200 километров, 400-450 км');
    expect(claims.map(c => c.value)).toEqual([60, 200, 400]);
    expect(claims.every(c => c.unit === 'km')).toBe(true);
  });

  it('часы — ТОЛЬКО рядом со словом пути', () => {
    // Без этого «работает с 9 часов» и «остывает за 2 часа» стали бы
    // находками, и пометка лепилась бы ко всему подряд.
    expect(findDistanceClaims('3-4 часа на машине').map(c => c.unit)).toEqual(['hour']);
    expect(findDistanceClaims('около часа езды').length).toBe(0); // «часа» без числа
    expect(findDistanceClaims('источник работает с 9 часов')).toEqual([]);
    expect(findDistanceClaims('вода остывает за 2 часа')).toEqual([]);
  });

  it('высота в метрах расстоянием не считается', () => {
    expect(findDistanceClaims('высота 3283 м')).toEqual([]);
  });
});

describe('источник — то же число в той же единице', () => {
  it('число из контекста подтверждено, чужое — нет', () => {
    const ctx = '[инструмент searchRoutes]\nМаршрут: длина 18.2 км, набор 900 м';
    expect(unsourcedClaims('Маршрут 18 км, идти легко', ctx)).toEqual([]);
    expect(unsourcedClaims('До места 200 км', ctx).map(c => c.value)).toEqual([200]);
  });

  it('голое совпадение числа в другой единице не засчитывается', () => {
    // «25» в контексте может быть ценой, вместимостью или высотой. Засчитывать
    // его за подтверждение расстояния значило бы заземлять ответ чем попало.
    const ctx = 'Вместимость: 25 человек в день';
    expect(unsourcedClaims('около 25 км от города', ctx).map(c => c.value)).toEqual([25]);
  });

  it('округление при пересказе придиркой не считается', () => {
    const ctx = 'длина 18.2 км';
    expect(unsourcedClaims('примерно 18 км', ctx)).toEqual([]);
  });
});

describe('пометка', () => {
  const ctx = 'Паратунские источники — традиция отдыха.';

  it('три вопроса из прогона 14.09 помечаются', () => {
    for (const answer of [
      'От Петропавловска-Камчатского до Паратунки примерно 60 километров.',
      'Малкинские источники — примерно 200 км от Петропавловска-Камчатского.',
      'До Курильского озера около 400 км, полноценный день пути.',
    ]) {
      const out = withDistanceCaveat(answer, ctx);
      expect(out.unsourced.length, answer).toBeGreaterThan(0);
      expect(out.text).toContain(DISTANCE_CAVEAT);
      // Число ОСТАЁТСЯ: режем источник доверия, а не текст ответа.
      expect(out.text).toContain(answer);
    }
  });

  it('верное, но неподтверждённое число тоже помечается', () => {
    // Авачинский, «около 25 км» — правда. Но источника нет, и турист не
    // отличит эту правду от соседней выдумки.
    const out = withDistanceCaveat('Авачинский — около 25 км от города.', ctx);
    expect(out.text).toContain(DISTANCE_CAVEAT);
  });

  it('подтверждённый ответ не трогается вовсе', () => {
    const answer = 'Длина маршрута 18.2 км.';
    const out = withDistanceCaveat(answer, 'Маршрут: длина 18.2 км');
    expect(out.text).toBe(answer);
    expect(out.unsourced).toEqual([]);
  });

  it('ответ без чисел не трогается', () => {
    const answer = 'Дорога грунтовая, нужен полный привод.';
    expect(withDistanceCaveat(answer, ctx).text).toBe(answer);
  });

  it('пустой контекст: подтверждать нечем — значит не подтверждено', () => {
    expect(withDistanceCaveat('До места 60 км.', '').unsourced.length).toBe(1);
  });

  it('пометка не дублируется при повторном проходе', () => {
    const once = withDistanceCaveat('До места 60 км.', ctx).text;
    const twice = withDistanceCaveat(once, ctx).text;
    expect(twice).toBe(once);
  });
});

describe('guard подключён на ОБА пути, а не на один', () => {
  it('живой чат и путь оценки зовут один и тот же guard', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');
    // Если пометка стоит только в живом чате, прогон оценки мерит НЕ ТО, что
    // получает турист, и дыра снова видна лишь археологией в логе.
    const uses = core.match(/withDistanceCaveat\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(core).toMatch(/withDistanceCaveat\(answer, systemContent\)/);
    expect(core).toMatch(/withDistanceCaveat\(cleanAIResponse\(raw\.trim\(\)\), context\)/);
  });

  it('пометка ставится ДО SOS-страховки — телефоны остаются последним словом', () => {
    // Порядок не косметический: блок 112/МЧС обязан быть виден целиком, а не
    // отодвинут вниз служебной сноской про километраж.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');
    const dist = core.indexOf('const withDistance = withDistanceCaveat(answer, systemContent)');
    const sos = core.indexOf('const finalAnswer = withSosBlock(withDistance', dist);
    expect(dist).toBeGreaterThan(-1);
    expect(sos).toBeGreaterThan(dist);
  });
});
