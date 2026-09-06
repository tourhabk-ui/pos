/**
 * Регрессионный прогон Кузьмича по эталонным safety-вопросам (issue #900).
 *
 * Задаёт живому Кузьмичу (POST /api/ai/chat) вопросы из GOLDEN_CASES и гонит
 * ответы через детерминированный чекер lib/kuzmich/safety-eval.ts. Любое
 * нарушение → exit 1: это release gate, красный прогон означает регрессию
 * safety-ответов и разбирается до релиза.
 *
 * С 06.09 прогон проверяет ОБЕ ошибки, а не одну. Прежде мерилось только
 * «не сказал ли опасного»; обратная ошибка — промолчать там, где ответ
 * обязан быть, — не ловилась ничем, и у десяти эталонов из шестнадцати
 * `mustMatch` был пуст, то есть «обратитесь к врачу» проходило их все.
 * BENIGN_CASES закрывают эту сторону: отказ на законном вопросе туриста
 * краснеет наравне с опасным советом.
 *
 * Молчание провайдеров при этом НЕ считается ни тем, ни другим: заглушку
 * водопада опознаёт classifyAnswer, и такой кейс не засчитывается вовсе —
 * иначе прогон объявил бы регрессию безопасности там, где не ответил никто.
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

import {
  GOLDEN_CASES, BENIGN_CASES, checkAnswer, checkBenign, classifyAnswer,
  type CaseResult,
} from '../lib/kuzmich/safety-eval';

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

  process.stdout.write(`Кузьмич safety-eval · ${GOLDEN_CASES.length} опасных + ${BENIGN_CASES.length} законных · ${BASE_URL}\n\n`);

  // Законные вопросы идут тем же прогоном: сеть, лимиты и пауза общие, а
  // разница только в том, ЧТО считается провалом. Второй скрипт ради этого
  // заводить незачем — это был бы второй прогон одного и того же чата.
  const ALL: Array<{ c: typeof GOLDEN_CASES[number]; benign: boolean }> = [
    ...GOLDEN_CASES.map((c) => ({ c, benign: false })),
    ...BENIGN_CASES.map((c) => ({ c, benign: true })),
  ];
  let refused = 0;

  for (const { c, benign } of ALL) {
    const answer = await askKuzmich(c.question, `${runId}-${c.id}`);
    // Заглушка водопада — НЕ ответ модели. Прогон, который её оценит,
    // объявит регрессию безопасности там, где просто не ответил никто
    // (эта подмена уже случалась у разведчика 04.09).
    if (answer == null || classifyAnswer(answer) === 'no_response') {
      unreachable++;
      process.stdout.write(`~ ${c.id}: ответа не было (сеть/лимит/провайдеры молчат) — кейс не засчитан\n`);
      await new Promise((r) => setTimeout(r, PAUSE_MS));
      continue;
    }
    const r = benign ? checkBenign(c, answer) : checkAnswer(c, answer);
    if (benign && 'kind' in r && r.kind === 'refused') refused++;
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
  process.stdout.write(`\n══ ИТОГ ══\nотвечено: ${results.length}/${ALL.length} · провалено: ${failed.length}`
    + ` (из них отказов на законных вопросах: ${refused}) · недоступно: ${unreachable}\n`);
  if (refused > 0) {
    process.stdout.write('Отказ на законном вопросе туриста — это НЕ осторожность: человек в поле,'
      + ' врача рядом нет. Разбирается наравне с опасным советом.\n');
  }

  // Больше половины кейсов без ответа — прогон не показателен: это красный
  // «инфраструктура», а не зелёный «всё хорошо». Молча зеленеть нельзя.
  if (results.length < ALL.length / 2) {
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
