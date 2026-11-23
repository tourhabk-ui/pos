/**
 * 502 с пустым телом — шлюз vedarai.ru, не роут и не реле.
 *
 * Прогон scout-digest 44954714899: POST /api/cron/scout-digest, HTTP 502,
 * тело пустое, 18 с. Прогон kuzmich-eval 43875975789: GET /api/cron/kuzmich-eval,
 * HTTP 502, тело пустое, 40 с; следующие шаги того же прогона получили 200.
 * Роут отвечает JSON. Повтор — только 502/503/504/000. Ошибка называет адрес.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isGatewayStatus,
  shouldRetryGateway,
  gatewayFailureNote,
  runGatewayRetry,
} from '../../scripts/cron-gateway-retry.mjs';

const SCOUT = 'https://vedarai.ru/api/cron/scout-digest';
const EVAL = 'https://vedarai.ru/api/cron/kuzmich-eval';

describe('шлюзовой отказ', () => {
  it('502, 503, 504 и обрыв — шлюз; 401, 429 и 500 роута — нет', () => {
    expect(isGatewayStatus(502)).toBe(true);
    expect(isGatewayStatus(503)).toBe(true);
    expect(isGatewayStatus(504)).toBe(true);
    expect(isGatewayStatus(0)).toBe(true);
    expect(isGatewayStatus(401)).toBe(false);
    expect(isGatewayStatus(429)).toBe(false);
    expect(isGatewayStatus(500)).toBe(false);
  });

  it('пустой 502 называет адрес и шлюз, а не роут', () => {
    const note = gatewayFailureNote({ url: SCOUT, status: 502, body: '', elapsedSec: 18 });
    expect(note).toContain(SCOUT);
    expect(note).toContain('502');
    expect(note).toContain('пустым телом');
    expect(note).toContain('шлюз');
    expect(note).not.toContain('CRON_SECRET');
  });

  it('500 с JSON — это уже роут, тело коротко в тексте', () => {
    const note = gatewayFailureNote({
      url: EVAL, status: 500, body: '{"error":"судья не ответил"}', elapsedSec: 40,
    });
    expect(note).toContain('судья не ответил');
    expect(note).not.toContain('шлюз или origin');
  });

  it('повтор, пока попытки не кончились и ответ пришёл быстро', () => {
    expect(shouldRetryGateway({ status: 502, elapsedSec: 18, attempt: 1, attempts: 3, fastOnlySec: null })).toBe(true);
    expect(shouldRetryGateway({ status: 0, elapsedSec: 2, attempt: 1, attempts: 2, fastOnlySec: 300 })).toBe(true);
    expect(shouldRetryGateway({ status: 500, elapsedSec: 2, attempt: 1, attempts: 3, fastOnlySec: null })).toBe(false);
    expect(shouldRetryGateway({ status: 502, elapsedSec: 18, attempt: 3, attempts: 3, fastOnlySec: null })).toBe(false);
    expect(shouldRetryGateway({ status: 502, elapsedSec: 301, attempt: 1, attempts: 2, fastOnlySec: 300 })).toBe(false);
  });

  it('прогон печатает отказ и не повторяет 500', () => {
    const calls: number[] = [];
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    const code = runGatewayRetry(
      { url: EVAL, out: '/tmp/out.json', attempts: 3, pauses: [20], fastOnlySec: null, method: 'GET', data: null, maxTime: 30 },
      () => {
        calls.push(1);
        return { status: 500, body: '{"error":"x"}', elapsedSec: 2, curlError: '' };
      },
      () => { throw new Error('паузы быть не должно'); },
    );
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('пустой 502 повторяется и после исчерпания попыток выходит с ошибкой', () => {
    let n = 0;
    const pauses: number[] = [];
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    const code = runGatewayRetry(
      { url: SCOUT, out: '/tmp/out.json', attempts: 3, pauses: [20, 40], fastOnlySec: null, method: 'POST', data: '/tmp/body.json', maxTime: 900 },
      () => {
        n += 1;
        return { status: 502, body: '', elapsedSec: 18, curlError: '' };
      },
      (sec) => { pauses.push(sec); },
    );
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
    expect(code).toBe(1);
    expect(n).toBe(3);
    expect(pauses).toEqual([20, 40]);
  });
});

describe('оба workflow зовут этот повтор', () => {
  it('scout-digest и kuzmich-eval не ходят curl-ом мимо скрипта', () => {
    const root = process.cwd();
    const scout = readFileSync(join(root, '.github/workflows/cron-scout-digest.yml'), 'utf8');
    const evalWf = readFileSync(join(root, '.github/workflows/cron-kuzmich-eval.yml'), 'utf8');
    expect(scout).toContain('scripts/cron-gateway-retry.mjs');
    expect(scout).toContain('https://vedarai.ru/api/cron/scout-digest');
    expect(evalWf.match(/scripts\/cron-gateway-retry\.mjs/g)?.length).toBe(3);
    expect(evalWf).toContain('--fast-only 300');
    expect(scout).not.toMatch(/curl[^\n]*scout-digest/);
    expect(evalWf).not.toMatch(/curl[^\n]*kuzmich-eval/);
  });
});
