/**
 * Причина отказа Anthropic — в тексте алерта health (24.09).
 *
 * Владелец переслал сводку, где «Anthropic недоступен с прода — и напрямую,
 * и через OpenRouter» было единственной строкой без причины. У отказа их три
 * разных, и чинятся они разным: баланс — пополнением, ключ — перевыпуском,
 * путь — сетью. Замер 03.09 (anthropic-path-probe) нашёл именно баланс, и
 * слово «недоступен» этого не говорило.
 *
 * Тела ответов — настоящей формы API Anthropic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explainAnthropicFailure } from '@/lib/ai/providers';

const HOST = 'vedar-ai-relay.tourhabk.workers.dev';
const CREDIT = '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
const AUTH = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
const NOT_FOUND = '{"type":"error","error":{"type":"not_found_error","message":"model: claude-fable-5"}}';

const d = (http_status: number | null, detail: string, key_set = true) => ({ key_set, route_host: HOST, http_status, detail });

describe('explainAnthropicFailure', () => {
  it('пустой баланс: путь открыт, чинится пополнением — не сетью и не ключом', () => {
    const s = explainAnthropicFailure(d(400, CREDIT));
    expect(s).toMatch(/путь через vedar-ai-relay\.tourhabk\.workers\.dev открыт/);
    expect(s).toMatch(/нет денег/);
    expect(s).toMatch(/пополнением/);
  });

  it('401 от самого Anthropic — ключ', () => {
    expect(explainAnthropicFailure(d(401, AUTH))).toMatch(/ключ отвергнут самим Anthropic \(401\)/);
  });

  it('403 не от Anthropic — путь закрыт по дороге', () => {
    expect(explainAnthropicFailure(d(403, 'Request not allowed'))).toMatch(/закрыт до Anthropic \(403, ответил не Anthropic\)/);
  });

  it('прочий ответ Anthropic цитируется его же словами', () => {
    const s = explainAnthropicFailure(d(404, NOT_FOUND));
    expect(s).toMatch(/HTTP 404 через .* \(ответ самого Anthropic\): model: claude-fable-5/);
  });

  it('сеть не дошла — «не смог», с хостом', () => {
    expect(explainAnthropicFailure(d(null, 'сеть/timeout: aborted'))).toBe(`через ${HOST}: сеть/timeout: aborted`);
  });

  it('2xx — не отказ, а живой провайдер', () => {
    expect(explainAnthropicFailure(d(200, '{"id":"msg_1"}'))).toMatch(/провайдер жив, отказа нет/);
  });

  it('ключа нет — так и сказано', () => {
    expect(explainAnthropicFailure(d(null, '', false))).toBe('ANTHROPIC_API_KEY не задан на Timeweb');
  });
});

describe('health несёт причину в текст, а не только в JSON', () => {
  const H = readFileSync(join(process.cwd(), 'app/api/cron/health/route.ts'), 'utf-8');
  it('диагностика собирается при заданном ключе и уходит в текст и в ответ', () => {
    expect(H).toMatch(/process\.env\.ANTHROPIC_API_KEY \? probeAnthropicKeyStatus\(\)\.catch\(\(\) => null\) : Promise\.resolve\(null\)/);
    expect(H).toMatch(/text: `Anthropic недоступен с прода — и напрямую, и через OpenRouter\$\{why\}`/);
    expect(H).toMatch(/anthropic_key_diag: anthropicKeyDiag,/);
  });
});
