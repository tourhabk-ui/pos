/**
 * Фактический экзамен Кузьмича (экзамен 22.10.2026, research/kuzmich-exam).
 *
 * Задаёт вопросы живому Кузьмичу через публичный A2A (/api/a2a), а эталон
 * берёт В МОМЕНТ ПРОГОНА из публичного MCP (/api/mcp) и календаря Камчатки.
 * Ничего не зашито: цена тура, прайс перевозчика, цена жилья — из ответа
 * инструмента; нет эталона — кейс помечается «нет эталона» и не судится.
 * Заявок не создаёт: в вопросах прямо сказано ничего не оформлять.
 */
import { factExamCases } from '../lib/kuzmich/fact-exam-cases';

const BASE = (process.env.BASE_URL || 'https://vedarai.ru').replace(/\/+$/, '');
const UA = 'vedar-eval/1.0 (kuzmich-fact-exam)';

async function a2a(q: string): Promise<string> {
  const body = { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: {
    role: 'user', kind: 'message', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text: q }] } } };
  const r = await fetch(`${BASE}/api/a2a`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const j = await r.json() as { result?: { status?: { message?: { parts?: { text?: string }[] } } } };
  return (j.result?.status?.message?.parts ?? []).map((p) => p.text ?? '').join('');
}

let sid: string | null = null;
async function mcp(method: string, params: unknown): Promise<unknown> {
  const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', 'user-agent': UA };
  if (sid) h['Mcp-Session-Id'] = sid;
  const r = await fetch(`${BASE}/api/mcp?self=vedar-eval`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
  sid = r.headers.get('mcp-session-id') ?? sid;
  let t = await r.text();
  if (t.includes('data:')) t = t.split('\n').filter((l) => l.startsWith('data:')).pop()!.slice(5);
  return JSON.parse(t);
}
async function tool(name: string, args: Record<string, string>): Promise<string> {
  const j = await mcp('tools/call', { name, arguments: args }) as { result?: { content?: { text?: string }[] } };
  return (j.result?.content ?? []).map((c) => c.text ?? '').join('');
}

// Кейсы — общие с пробой своей модели (scripts/local-brain-probe.ts).
const CASES = factExamCases(tool);

async function main() {
  await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vedar-eval', version: '1' } });
  let failed = 0; let judged = 0;
  for (const c of CASES) {
    const check = await c.expect().catch(() => null);
    const answer = await a2a(c.q).catch((e: unknown) => `ОШИБКА ${String(e)}`);
    if (!check) { process.stdout.write(`– ${c.id}: нет эталона, не судится\n`); continue; }
    judged += 1;
    const why = check(answer);
    if (why) { failed += 1; process.stdout.write(`× ${c.id}: ${why}\n    ответ целиком:\n${answer.split('\n').map((l) => `      ${l}`).join('\n')}\n`); }
    else process.stdout.write(`✓ ${c.id}\n`);
  }
  process.stdout.write(`\nИТОГ: судилось ${judged}, провалено ${failed}\n`);
  if (failed > 0) process.exitCode = 1;
}
void main();
