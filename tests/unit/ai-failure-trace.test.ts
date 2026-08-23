/**
 * След отказа быстрой ветки: КТО не ответил и ПОЧЕМУ.
 *
 * Повод 23.08. Scout сообщал `judge_unavailable` — «не ответил ни один
 * провайдер, чинить у провайдера». Владелец проверил: DEEPSEEK_API_KEY на
 * Timeweb стоит. Дальше диагностика упиралась в код: каждая нога гонки
 * приводила ЛЮБОЙ свой отказ к одному `null` через `catch { return null }`.
 * Нет ключа, 401, 402, таймаут, пустой ответ — снаружи неразличимо, и совет
 * «чинить у провайдера» не давал сделать ни одного шага.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  recordAiLegFailure,
  httpFailureReason,
  errorFailureReason,
  recentAiFailures,
  describeRecentAiFailures,
} from '@/lib/ai/failure-trace';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('след отказа', () => {
  beforeEach(() => {
    // Кольцо переполняем, чтобы прошлые записи не мешали: отдельного сброса
    // намеренно нет — это диагностика, а не состояние, которым управляют.
    for (let i = 0; i < 20; i++) recordAiLegFailure('шум', 'сброс');
  });

  it('называет провайдера и причину, а не «никто не ответил»', () => {
    recordAiLegFailure('deepseek', httpFailureReason(402, 'Insufficient Balance'));
    const line = describeRecentAiFailures();
    expect(line).toContain('deepseek');
    expect(line).toContain('http_402');
    expect(line).toContain('Insufficient Balance');
  });

  it('таймаут отличается от кода ответа', () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    expect(errorFailureReason(e)).toBe('timeout');
    expect(httpFailureReason(401)).toBe('http_401');
  });

  it('ключи в след не попадают', () => {
    recordAiLegFailure('deepseek', httpFailureReason(401, 'Invalid key sk-abcdef0123456789'));
    const line = describeRecentAiFailures() ?? '';
    expect(line, 'ключ утёк в диагностику').not.toMatch(/sk-abcdef/);
    expect(line).toContain('<ключ скрыт>');
  });

  it('пустой след — это «следа нет», а не «всё хорошо»', () => {
    // Окно в будущем: записей в нём быть не может по построению. Нулевое не
    // годится — записи этой же миллисекунды в него попадают.
    expect(recentAiFailures(-1)).toEqual([]);
    expect(describeRecentAiFailures(-1), 'пустой след выдан за строку с причинами').toBeNull();
  });
});

describe('ноги гонки перестали глотать причину', () => {
  const providers = read('lib/ai/providers.ts');

  it('каждая нога callAIFast сообщает об отсутствии ключа', () => {
    for (const p of ['deepseek', 'kimi', 'gemini', 'openrouter']) {
      expect(providers, `${p} молча выпадает из гонки без ключа`)
        .toMatch(new RegExp(`recordAiLegFailure\\('${p}', 'no_key'\\)`));
    }
  });

  it('HTTP-отказ и исключение называются по-разному', () => {
    expect(providers).toMatch(/recordAiLegFailure\('deepseek', httpFailureReason\(res\.status/);
    expect(providers).toMatch(/recordAiLegFailure\('deepseek', errorFailureReason\(e\)\)/);
  });

  it('качественный путь тоже называет отказ ступени', () => {
    expect(providers).toMatch(/recordAiLegFailure\('deepseek:content'/);
    expect(providers).toMatch(/recordAiLegFailure\('qwen:content'/);
  });

  it('преполётная проверка накрывает ноги судьи, а не только DeepSeek', () => {
    // До 23.08 Qwen, Kimi и Gemini в пробе не было — экран мог быть зелёным
    // при мёртвых ногах, которыми и живёт судья фактгейта.
    for (const id of ['qwen', 'kimi', 'gemini']) {
      expect(providers, `${id} не проверяется преполётной пробой`)
        .toMatch(new RegExp(`probeDetailed\\('${id}'`));
    }
  });
});

describe('отказ судьи доносит след до алерта', () => {
  const factCheck = read('lib/agents/fact-check.ts');

  it('к коду unavailable прикладывается кто и с чем отказал', () => {
    expect(factCheck).toMatch(/describeRecentAiFailures\(\)/);
    expect(factCheck).toMatch(/why: 'unavailable'[\s\S]{0,80}sample: trace/);
  });
});
