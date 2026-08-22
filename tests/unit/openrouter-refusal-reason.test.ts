/**
 * Отказ провайдера называет причину, а не только факт отказа.
 *
 * 22.08 отчёт судьи (issue #1332) сорок восемь раз повторил про первую
 * ступень «ключ есть, ответа нет». Прогон шёл на раннере GitHub — вне РФ,
 * без релея, с ключом из секретов, — то есть ни гео-блок, ни релей к делу
 * не относились. А чем именно ответил OpenRouter (401 недействительный
 * ключ, 402 нет средств, 403 политика), из отчёта узнать было нельзя.
 *
 * Соседняя ступень в том же отчёте печатала настоящее тело ошибки Anthropic
 * («Your credit balance is too low...»), и разница бросалась в глаза:
 * `callOpenRouterModel` глотал `res.status` и тело, возвращая голый `null`
 * на четыре разных события — отказ по HTTP, пустой текст, обрыв сети,
 * отсутствие ключа.
 *
 * Это то самое «место, где нельзя сказать „не знаю“» (§4.0): обтекаемая
 * формулировка вместо третьего исхода. Сторож держит, чтобы причина не
 * пропала снова.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

const fn = (name: string, until: string) =>
  SRC.slice(SRC.indexOf(name), SRC.indexOf(until, SRC.indexOf(name)));

describe('callOpenRouterModel: у отказа есть причина', () => {
  const FN = fn('export async function callOpenRouterModel', '// ── OpenRouter: Function calling');

  it('различает четыре повода вернуть null', () => {
    // Все четыре снаружи выглядели одинаково — в этом и была беда.
    for (const kind of ['no_key', 'http', 'empty', 'network']) {
      expect(FN, `повод ${kind} не назван`).toMatch(new RegExp(`kind: '${kind}'`));
    }
  });

  it('на отказ по HTTP отдаёт код и тело ответа', () => {
    expect(FN).toMatch(/status: res\.status/);
    expect(FN).toMatch(/await res\.text\(\)/);
    // Тело обрезается: в ответе провайдера бывает эхо запроса.
    expect(FN).toMatch(/\.slice\(0, \d+\)/);
  });

  it('возврат остался прежним — сообщается причина, а не меняется поведение', () => {
    // Если бы отказ начал бросать исключение, водопад перестал бы съезжать
    // на следующую ступень, и «диагностика» обернулась бы отказом сервиса.
    const nulls = FN.match(/return null;/g) ?? [];
    expect(nulls.length).toBeGreaterThanOrEqual(4);
  });
});

describe('отчёт решателя', () => {
  const FN = fn('export async function callAIDecisionDetailed', '\nexport ');

  it('первая ступень пишет в provenance причину отказа', () => {
    expect(FN).toMatch(/onRefusal/);
    expect(FN).toMatch(/HTTP \$\{status\}/);
  });

  it('прежняя формулировка осталась запасной, а не единственной', () => {
    // «ключ есть, ответа нет» — честный ответ ровно тогда, когда причины
    // действительно нет. Единственным он быть больше не должен.
    expect(FN).toMatch(/refusal \?\? 'ключ есть, ответа нет'/);
  });
});
