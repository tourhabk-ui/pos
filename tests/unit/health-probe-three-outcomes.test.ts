/**
 * У пробы провайдера три исхода, и третий не равен второму.
 *
 * ── Случай 20.09 ───────────────────────────────────────────────────────────
 *
 * Владелец переслал тревогу высшего уровня:
 *
 *   CRIT: Все AI-провайдеры недоступны — ... DeepSeek: HTTP 200:
 *   {"id":"3620e324-...","object":"chat.completion","model":"deepseek-v4-pro"...
 *
 * Заголовок опровергался собственным телом: провайдер, приславший
 * `chat.completion` с кодом 200, недоступным не является.
 *
 * Механизм собрался из трёх мест, и каждое по отдельности выглядело невинно:
 *
 *  1. `probeAI` давала провайдеру 8 секунд и возвращала `false` по таймауту —
 *     неотличимо от настоящего отказа. Два исхода там, где их три.
 *  2. `explainDeepSeekFailure` не имела ветки для успеха: 200 доезжал до
 *     последней строки `HTTP ${status}: ${detail}` и форматировался как
 *     причина недоступности. Функция называется «объясни отказ», и что в неё
 *     придёт успех, не предполагал никто.
 *  3. `anyOk` считался ТОЛЬКО по быстрым пробам. Диагностики, которые ходят
 *     дольше и знают больше, в нём не участвовали — поэтому пять таймаутов
 *     стали «недоступны все», хотя улика обратного лежала в том же ответе.
 *
 * Это §4.0 в чистом виде: место, где нельзя сказать «не знаю», заполняется
 * неправдой. И цена не теоретическая — ложный CRIT будит владельца и учит
 * пролистывать сводку, а настоящая новость того же письма (DeepSeek стал
 * отвечать дольше восьми секунд против 0,3 замеренных 04.09) утонула.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagnosticSaysAlive, explainDeepSeekFailure } from '@/lib/ai/providers';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const HEALTH = read('app/api/cron/health/route.ts');

/** Дословное тело из письма владельца 20.09. */
const REAL_200_BODY =
  '{"id":"3620e324-76c0-413c-b840-44744b17627d","object":"chat.completion",' +
  '"created":1789859469,"model":"deepseek-v4-pro","choices":[{"index":0}]}';

describe('успех диагностики читается как успех', () => {
  it('2xx — провайдер жив', () => {
    for (const s of [200, 201, 204, 299]) expect(diagnosticSaysAlive(s), String(s)).toBe(true);
  });

  it('всё остальное живым не считается', () => {
    for (const s of [301, 400, 401, 402, 403, 429, 500, 503]) {
      expect(diagnosticSaysAlive(s), String(s)).toBe(false);
    }
  });

  it('отсутствие кода — не «жив»: сеть не дошла, и это третий исход', () => {
    expect(diagnosticSaysAlive(null)).toBe(false);
    expect(diagnosticSaysAlive(undefined)).toBe(false);
  });
});

describe('объяснение отказа не объясняет успех', () => {
  it('на настоящем теле из письма владельца говорит «жив», а не перечисляет его причиной', () => {
    const said = explainDeepSeekFailure({ key_set: true, http_status: 200, detail: REAL_200_BODY });
    expect(said).toMatch(/жив/i);
    expect(said, 'тело успешного ответа снова уехало в текст причины')
      .not.toContain('chat.completion');
  });

  it('настоящие отказы объясняются как прежде', () => {
    const cases: Array<[number | null, RegExp]> = [
      [401, /отвергнут/],
      [402, /баланс/],
      [429, /лимит/],
      [503, /сбой на стороне/],
    ];
    for (const [status, want] of cases) {
      expect(explainDeepSeekFailure({ key_set: true, http_status: status, detail: 'x' }), String(status))
        .toMatch(want);
    }
    expect(explainDeepSeekFailure({ key_set: false, http_status: null, detail: '' }))
      .toMatch(/не задан/);
  });
});

describe('проба различает «не ответил» и «не успел»', () => {
  it('исходов объявлено три', () => {
    expect(HEALTH).toMatch(/export type ProbeOutcome = 'ok' \| 'slow' \| 'fail'/);
  });

  it('таймаут возвращает slow, а не fail', () => {
    const fn = HEALTH.slice(HEALTH.indexOf('async function probeAI'), HEALTH.indexOf('// ── DB checks'));
    expect(fn).toContain("return 'slow'");
    expect(fn, 'таймаут снова отдаёт булево — третий исход потерян')
      .not.toMatch(/return !!res/);
  });

  it('бюджет пробы назван константой, а не числом в строке', () => {
    // Иначе текст алерта («дольше 8 с») и сама проба разойдутся молча.
    expect(HEALTH).toMatch(/AI_PROBE_TIMEOUT_MS = 8_000/);
    expect(HEALTH).toContain('AI_PROBE_TIMEOUT_MS)');
  });
});

describe('CRIT смотрит на собственные улики', () => {
  it('провайдер жив, если проба ок ИЛИ диагностика ответила 2xx', () => {
    for (const line of ['deepseekAlive', 'openrouterAlive', 'qwenAlive']) {
      expect(HEALTH, `нет признака ${line}`).toContain(line);
    }
    expect(HEALTH).toMatch(/deepseekAlive\s+= deepseekOk\s+\|\| diagnosticSaysAlive\(dsKeyDiag\?\.http_status\)/);
  });

  it('anyOk считается по живым, а не по одним быстрым пробам', () => {
    const line = HEALTH.slice(HEALTH.indexOf('const anyOk ='), HEALTH.indexOf(';', HEALTH.indexOf('const anyOk =')));
    expect(line).toContain('deepseekAlive');
    expect(line).toContain('openrouterAlive');
    expect(line).toContain('qwenAlive');
    expect(line, 'anyOk снова считается по одним быстрым пробам')
      .not.toMatch(/\bdeepseekOk\b/);
  });

  it('медленный, но живой DeepSeek идёт отдельным WARN, а не словом «недоступен»', () => {
    const branch = HEALTH.slice(HEALTH.indexOf('if (!deepseekOk && dsKeyDiag?.key_set !== false)'));
    const body = branch.slice(0, branch.indexOf('\n    }\n'));
    expect(body).toContain('if (deepseekAlive)');
    expect(body).toMatch(/отвечает дольше/);
    expect(body).toMatch(/жив/);
  });
});

describe('прежнее поведение не сломано', () => {
  it('уровень known остаётся: принятое положение не шумит и не исчезает', () => {
    expect(HEALTH).toContain("level: isAcceptedOpenRouterGeoBlock(orKeyDiag) ? 'known' : 'warn'");
    expect(HEALTH).toMatch(/known_states/);
  });

  it('CRIT при настоящем отказе всех по-прежнему собирает КАЖДУЮ причину', () => {
    expect(HEALTH).toMatch(/Все AI-провайдеры недоступны — \$\{reasons\.join\('; '\)\}/);
  });

  it('провайдер без ключа в обвинение не попадает', () => {
    expect(HEALTH).toMatch(/dsKeyDiag\?\.key_set !== false/);
    expect(HEALTH).toMatch(/process\.env\.DASHSCOPE_API_KEY && !qwenOk/);
  });
});
