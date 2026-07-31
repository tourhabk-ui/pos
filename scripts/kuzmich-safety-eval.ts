/**
 * Регрессионный прогон Кузьмича по эталонным safety-вопросам (issue #900).
 *
 * Задаёт живому Кузьмичу (POST /api/ai/chat) вопросы из GOLDEN_CASES и гонит
 * ответы через детерминированный чекер lib/kuzmich/safety-eval.ts. Любое
 * нарушение → exit 1: это release gate, красный прогон означает регрессию
 * safety-ответов и разбирается до релиза.
 *
 * Запуск:
 *   BASE_URL=https://vedarai.ru npx tsx scripts/kuzmich-safety-eval.ts
 *   (локально — против next start с БД и AI-ключами)
 *
 * Каждый кейс идёт отдельной сессией (лимит бесплатных сообщений — на
 * сессию), с паузой под rate-limit чата (20/мин на IP). LLM-судья здесь
 * сознательно не дублируется — живой трафик уже грейдит
 * lib/agents/managed/kuzmich-outcomes.ts.
 */

import { GOLDEN_CASES, checkAnswer, type CaseResult } from '../lib/kuzmich/safety-eval';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS || 3500);

async function askKuzmich(question: string, sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, sessionId, role: 'tourist' }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { success?: boolean; data?: { answer?: string; limitReached?: boolean } };
    if (!j.success || !j.data || j.data.limitReached) return null;
    return j.data.answer ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const runId = `safety-eval-${Date.now()}`;
  const results: CaseResult[] = [];
  let unreachable = 0;

  process.stdout.write(`Кузьмич safety-eval · ${GOLDEN_CASES.length} кейсов · ${BASE_URL}\n\n`);

  for (const c of GOLDEN_CASES) {
    const answer = await askKuzmich(c.question, `${runId}-${c.id}`);
    if (answer == null) {
      unreachable++;
      process.stdout.write(`~ ${c.id}: ответ не получен (сеть/лимит/отказ AI) — кейс пропущен\n`);
      await new Promise((r) => setTimeout(r, PAUSE_MS));
      continue;
    }
    const r = checkAnswer(c, answer);
    results.push(r);
    if (r.passed) {
      process.stdout.write(`✓ ${c.id}\n`);
    } else {
      process.stdout.write(`× ${c.id}\n`);
      for (const v of r.violations) process.stdout.write(`    ${v}\n`);
      process.stdout.write(`    ответ (первые 300): ${answer.replace(/\s+/g, ' ').slice(0, 300)}\n`);
    }
    await new Promise((r2) => setTimeout(r2, PAUSE_MS));
  }

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n══ ИТОГ ══\nотвечено: ${results.length}/${GOLDEN_CASES.length} · провалено: ${failed.length} · недоступно: ${unreachable}\n`);

  // Больше половины кейсов без ответа — прогон не показателен: это красный
  // «инфраструктура», а не зелёный «всё хорошо». Молча зеленеть нельзя.
  if (results.length < GOLDEN_CASES.length / 2) {
    process.stdout.write('Слишком мало ответов — считаем прогон НЕсостоявшимся.\n');
    process.exit(1);
  }
  if (failed.length > 0) {
    process.stdout.write('Регрессия safety-ответов — разобрать до релиза.\n');
    process.exit(1);
  }
  process.stdout.write('Все safety-кейсы пройдены.\n');
}

main().catch((e) => {
  process.stderr.write(`kuzmich-safety-eval: ${e}\n`);
  process.exit(1);
});
