/**
 * Диагностика OpenRouter обязана называть АДРЕСАТА, а не только код ответа.
 *
 * Вопрос владельца 22.08: «Cloudflare уже настраивали, почему не работает?».
 * Ответить по снимку здоровья было нельзя: там стояло `http_status: 403` без
 * указания, куда ушёл запрос. А это две разные болезни с разным лечением:
 *   403 напрямую   — гео-блок РФ-адреса, лечится релеем;
 *   403 через релей — сам релей (не задан, не тот путь, закрыт по РФ),
 *                     и релей тут добавлять уже бессмысленно.
 * Голый код без адресата — то самое «место, где нельзя сказать „не знаю“»
 * (§4.0): читатель домысливает причину, и домысливает неверно.
 *
 * Сторож держит: поле маршрута есть, оно выводится из ФАКТИЧЕСКОЙ базы, и
 * наружу идёт только хост — ни пути, ни ключей.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');
const FN = SRC.slice(
  SRC.indexOf('export async function probeOpenRouterKeyStatus'),
  SRC.indexOf('export async function callOpenrouter'),
);

describe('probeOpenRouterKeyStatus: маршрут в диагнозе', () => {
  it('различает релей и прямой путь', () => {
    expect(FN).toMatch(/route: 'relay' \| 'direct'/);
    expect(FN).toMatch(/OPENROUTER_BASE === 'https:\/\/openrouter\.ai\/api\/v1'\s*\?\s*'direct'\s*:\s*'relay'/);
  });

  it('маршрут выводится из фактической базы, а не из наличия env', () => {
    // Если бы судили по !!process.env.OPENROUTER_BASE_URL, то релей, заданный
    // равным прямому адресу, числился бы релеем — и диагноз снова врал бы.
    expect(FN).toMatch(/OPENROUTER_BASE ===/);
    expect(FN).not.toMatch(/route.*!!process\.env\.OPENROUTER_BASE_URL/);
  });

  it('наружу идёт только хост — без пути и без ключей', () => {
    expect(FN).toMatch(/route_host/);
    expect(FN).toMatch(/new URL\(OPENROUTER_BASE\)\.host/);
    // Полная база наружу не отдаётся: в ней может быть путь релея.
    expect(FN).not.toMatch(/base: OPENROUTER_BASE/);
    expect(FN).not.toMatch(/route_host = OPENROUTER_BASE\b/);
  });

  it('маршрут сообщается и когда ключа нет, и когда сеть молчит', () => {
    // Иначе «ключ не задан» и таймаут снова оставили бы читателя без адресата.
    const branches = FN.match(/route,\s*route_host,/g) ?? [];
    expect(branches.length).toBeGreaterThanOrEqual(3);
  });
});
