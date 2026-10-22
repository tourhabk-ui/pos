/**
 * Проба своей модели на своём железе — docs/LOCAL_BRAIN.md, план §6
 * docs/OWN_BRAIN_PLAN.md.
 *
 * Модель отвечает на вопросы эвала Кузьмича (safety: опасные и законные,
 * фактический экзамен) с системным промптом Кузьмича и ЧИТАЮЩИМИ
 * инструментами публичного MCP vedarai.ru. Ответы судятся теми же
 * детерминированными чекерами, что еженедельный эвал живого Кузьмича
 * (lib/kuzmich/safety-eval.ts, lib/kuzmich/fact-exam-cases.ts).
 *
 * Запуск (на компьютере с моделью):
 *   LOCAL_LLM_MODEL=<имя из `ollama list`> npx tsx scripts/local-brain-probe.ts
 *
 * Переменные:
 *   LOCAL_LLM_URL        по умолчанию http://127.0.0.1:11434/v1 (Ollama);
 *                        только этот компьютер или домашняя сеть
 *   LOCAL_LLM_MODEL      обязательно
 *   LOCAL_LLM_KEY        если сервер модели требует ключ (LM Studio, vLLM)
 *   LOCAL_LLM_THINK=1    не выключать размышление модели
 *   LOCAL_LLM_TIMEOUT_MS по умолчанию 180000 на один запрос
 *   PROBE_ONLY           safety | fact — только один набор
 *   PROBE_BASE=1         те же вопросы живому Кузьмичу (A2A) — сравнение в
 *                        тот же день; это вызовы модели на проде, по
 *                        умолчанию выключено
 *   BASE_URL             по умолчанию https://vedarai.ru
 *
 * Отчёт — local-brain-reports/<модель>-<время>.json (в .gitignore): ответы
 * целиком, время, вызовы инструментов, finish_reason, размышление.
 * Персональных данных в пробе нет: вопросы — эталонные, заявок проба не
 * создаёт (пишущие инструменты модели не предлагаются).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GOLDEN_CASES, BENIGN_CASES, checkAnswer, checkBenign, classifyAnswer,
} from '../lib/kuzmich/safety-eval';
import { factExamCases, type FactCheck } from '../lib/kuzmich/fact-exam-cases';
import { KUZMICH_SYSTEM } from '../lib/kuzmich/core';
import { kamchatkaDateContext } from '../lib/kuzmich/date-context';
import {
  readLocalModelConfig, readOnlyToolsForProbe, runProbeTurn, summarizeProbe, createMcpClient,
  type TurnResult,
} from '../lib/ai/local-model-probe';

const BASE = (process.env.BASE_URL || 'https://vedarai.ru').replace(/\/+$/, '');
const PAUSE_MS = Number(process.env.PROBE_PAUSE_MS || 1000);
const ONLY = process.env.PROBE_ONLY;
const WITH_BASE = process.env.PROBE_BASE === '1';
// Средний веб-ответ живого Кузьмича, prod-check 148 (22.10): p95 8,3 с.
const LIVE_P95_MS = 8300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function askLiveKuzmich(q: string): Promise<string | null> {
  try {
    const body = { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: {
      role: 'user', kind: 'message', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text: q }] } } };
    const r = await fetch(`${BASE}/api/a2a`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'vedar-local-brain-probe/1.0' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(240_000),
    });
    const j = await r.json() as { result?: { status?: { message?: { parts?: { text?: string }[] } } } };
    const t = (j.result?.status?.message?.parts ?? []).map((p) => p.text ?? '').join('');
    return t || null;
  } catch {
    return null;
  }
}

interface Row {
  set: 'safety-danger' | 'safety-benign' | 'fact';
  id: string;
  question: string;
  verdict: 'pass' | 'fail' | 'no_response' | 'not_judged';
  why: string[];
  local: TurnResult;
  base?: { answer: string | null; verdict: Row['verdict']; why: string[] };
}

function judgeSafety(benign: boolean, c: typeof GOLDEN_CASES[number], answer: string | null): { verdict: Row['verdict']; why: string[] } {
  if (answer == null || classifyAnswer(answer) === 'no_response') return { verdict: 'no_response', why: [] };
  const r = benign ? checkBenign(c, answer) : checkAnswer(c, answer);
  return { verdict: r.passed ? 'pass' : 'fail', why: r.violations };
}

function judgeFact(check: FactCheck | null, answer: string | null): { verdict: Row['verdict']; why: string[] } {
  if (!check) return { verdict: 'not_judged', why: ['эталона нет на момент прогона'] };
  if (!answer) return { verdict: 'no_response', why: [] };
  const why = check(answer);
  return why ? { verdict: 'fail', why: [why] } : { verdict: 'pass', why: [] };
}

async function main() {
  const conf = readLocalModelConfig(process.env);
  if (!conf.ok) { process.stderr.write(`${conf.error}\n`); process.exit(2); }
  const cfg = conf.cfg;

  const mcp = createMcpClient(BASE);
  const instructions = await mcp.initialize();
  const tools = readOnlyToolsForProbe(await mcp.listTools());
  if (!tools.length) { process.stderr.write('MCP не отдал ни одного читающего инструмента — проба без фактов бессмысленна.\n'); process.exit(1); }
  const system = [KUZMICH_SYSTEM, kamchatkaDateContext(), instructions ? `Справка сервера инструментов:\n${instructions}` : '']
    .filter(Boolean).join('\n\n');

  process.stdout.write(`Проба своей модели · ${cfg.model} · ${new URL(cfg.baseUrl).host}\n`);
  process.stdout.write(`Инструменты (${tools.length}, только чтение): ${tools.map((t) => t.function.name).join(', ')}\n`);
  process.stdout.write(`Размышление: ${cfg.noThink ? 'просим выключить' : 'не трогаем'}${WITH_BASE ? ' · сравнение с живым Кузьмичом' : ''}\n\n`);

  // Прогрев: первая загрузка модели в память займёт десятки секунд и
  // испортила бы p95, поэтому в счёт не идёт.
  const warm = await runProbeTurn({ cfg, system: 'Ответь одним словом.', question: 'Привет', tools: [], callTool: async () => '' });
  if (warm.error) {
    process.stderr.write(`Модель не отвечает: ${warm.error}\nПроверьте, что сервер модели запущен и имя модели верное (ollama list).\n`);
    process.exit(1);
  }
  process.stdout.write(`Прогрев: ${(warm.ms / 1000).toFixed(1)} с\n\n`);

  const callTool = (name: string, args: Record<string, unknown>) => mcp.callTool(name, args);
  const rows: Row[] = [];

  const safety = ONLY && ONLY !== 'safety' ? [] : [
    ...GOLDEN_CASES.map((c) => ({ c, benign: false })),
    ...BENIGN_CASES.map((c) => ({ c, benign: true })),
  ];
  for (const { c, benign } of safety) {
    const local = await runProbeTurn({ cfg, system, question: c.question, tools, callTool });
    const j = judgeSafety(benign, c, local.error ? null : local.answer);
    const row: Row = { set: benign ? 'safety-benign' : 'safety-danger', id: c.id, question: c.question, ...j, local };
    if (WITH_BASE) { const a = await askLiveKuzmich(c.question); row.base = { answer: a, ...judgeSafety(benign, c, a) }; }
    rows.push(row);
    process.stdout.write(`${row.verdict === 'pass' ? '✓' : row.verdict === 'fail' ? '×' : '~'} ${c.id} · ${(local.ms / 1000).toFixed(1)} с`
      + `${local.toolCalls.length ? ` · инструменты: ${local.toolCalls.join(', ')}` : ''}${local.error ? ` · ${local.error}` : ''}\n`);
    for (const w of j.why) process.stdout.write(`    ${w}\n`);
    await sleep(PAUSE_MS);
  }

  const facts = ONLY && ONLY !== 'fact' ? [] : factExamCases((name, args) => mcp.callTool(name, args));
  for (const c of facts) {
    const check = await c.expect().catch(() => null);
    const local = await runProbeTurn({ cfg, system, question: c.q, tools, callTool });
    const j = judgeFact(check, local.error ? null : local.answer);
    const row: Row = { set: 'fact', id: c.id, question: c.q, ...j, local };
    if (WITH_BASE) { const a = await askLiveKuzmich(c.q); row.base = { answer: a, ...judgeFact(check, a) }; }
    rows.push(row);
    process.stdout.write(`${row.verdict === 'pass' ? '✓' : row.verdict === 'fail' ? '×' : '~'} ${c.id} · ${(local.ms / 1000).toFixed(1)} с${local.error ? ` · ${local.error}` : ''}\n`);
    for (const w of j.why) process.stdout.write(`    ${w}\n`);
    await sleep(PAUSE_MS);
  }

  const s = summarizeProbe(rows.map((r) => r.local));
  const count = (set: Row['set'] | null, v: Row['verdict']) => rows.filter((r) => (set ? r.set === set : true) && r.verdict === v).length;
  const lines = [
    '',
    '══ ИТОГ ══',
    `ответов: ${s.answered}/${s.total} · пусто: ${s.empty} (из них упор в длину: ${s.lengthCut}) · отказ запроса: ${s.errors}`,
    `безопасность, опасные: прошло ${count('safety-danger', 'pass')}, провал ${count('safety-danger', 'fail')}, без ответа ${count('safety-danger', 'no_response')}`,
    `безопасность, законные: прошло ${count('safety-benign', 'pass')}, провал ${count('safety-benign', 'fail')}, без ответа ${count('safety-benign', 'no_response')}`,
    `факты: прошло ${count('fact', 'pass')}, провал ${count('fact', 'fail')}, не судилось ${count('fact', 'not_judged')}`,
    `скорость: p50 ${s.p50Ms != null ? (s.p50Ms / 1000).toFixed(1) : '—'} с, p95 ${s.p95Ms != null ? (s.p95Ms / 1000).toFixed(1) : '—'} с`
      + ` (живой Кузьмич в вебе: p95 ${(LIVE_P95_MS / 1000).toFixed(1)} с) · ${s.tokensPerSec ?? '—'} ток/с`,
    `с инструментами: ${s.turnsWithTools} ответов из ${s.total}`,
  ];
  if (s.thinkNotSupported) lines.push('Модель не принимает выключатель размышления — время включает её размышления.');
  if (s.contextWarnings) lines.push(`ВНИМАНИЕ: у ${s.contextWarnings} ответов похоже на обрезанный контекст — см. contextWarning в отчёте; итог тогда не показателен.`);
  if (WITH_BASE) {
    const basePass = rows.filter((r) => r.base?.verdict === 'pass').length;
    const onlyLocalFail = rows.filter((r) => r.verdict === 'fail' && r.base?.verdict === 'pass').map((r) => r.id);
    lines.push(`живой Кузьмич на тех же вопросах: прошло ${basePass}; провалы только у своей модели: ${onlyLocalFail.join(', ') || 'нет'}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  const dir = join(process.cwd(), 'local-brain-reports');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${cfg.model.replace(/[^a-zA-Z0-9._-]+/g, '_')}-${stamp}.json`);
  writeFileSync(file, JSON.stringify({
    model: cfg.model, host: new URL(cfg.baseUrl).host, noThink: cfg.noThink, withBase: WITH_BASE,
    tools: tools.map((t) => t.function.name), warmupMs: warm.ms, summary: s, rows,
  }, null, 2));
  process.stdout.write(`\nОтчёт: ${file}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`local-brain-probe: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
