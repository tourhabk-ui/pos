/**
 * lib/agents/eval/kuzmich-faithfulness.ts
 *
 * Faithfulness-регрессия живых RAG-ответов Кузьмича (Roitman §16.8.3,
 * RAGAs-подобно, без фреймворка). Editor уже имеет офлайн-оценку качества
 * (editor-judge.ts/editor-regression.ts) — у гибридного RRF-retrieval
 * Кузьмича (lib/kuzmich/core.ts) её не было: деградацию retrieval/промпта
 * первым увидит турист на живом чате, а не мониторинг.
 *
 * Фикстура kuzmich-eval-questions.json — 20 фиксированных вопросов по
 * реальным объектам платформы (места уже фигурируют как реальные в
 * KUZMICH_SYSTEM, lib/kuzmich/core.ts). ВАЖНО: существование каждого места
 * в текущей prod-БД `places` НЕ проверено live-запросом из этой сессии
 * разработки — нет доступа к прод-БД. Перед первым прогоном на проде
 * сверить через /api/admin/audit-knowledge или ручной SELECT.
 *
 * Судья — по образцу editor-judge.ts: reference-guided (даём retrieved-
 * контекст, который реально был в промпте), рассуждение перед вердиктом,
 * штраф за выдуманные факты безопасности выше, чем за обычную неточность.
 */

import { askKuzmichForEval } from '@/lib/kuzmich/core';
import { callAIFast } from '@/lib/ai/providers';
import { parseJudgeScore } from '@/lib/agents/eval/editor-judge';
import { wilsonInterval, type WilsonInterval } from '@/lib/agents/learning/experiment-tracker';
import questionsFixture from '@/lib/agents/eval/kuzmich-eval-questions.json';

export interface EvalQuestion {
  id: string;
  category: 'route' | 'safety' | 'season' | 'logistics';
  question: string;
}

export interface EvalCase {
  id: string;
  category: string;
  question: string;
  answer: string | null;
  context_len: number;
  score: number | null; // null = нет ответа, либо судья недоступен/не распарсился
  reason: string;
}

export interface EvalReport {
  asked: number;
  judged: number;
  pass_rate: number;      // доля score>=PASS_MIN среди judged (0, если judged=0)
  wilson_low: number;
  wilson_high: number;
  judge_unavailable_ratio: number; // (asked - judged) / asked
  alerts_sent: boolean;
  cases: EvalCase[];
}

const PASS_MIN = 4;                 // балл судьи >=4 считаем faithful (как QUALITY_GOOD_MIN у editor)
const ALERT_PASS_RATE_THRESHOLD = 0.8;
const ALERT_JUDGE_NULL_RATIO = 0.3; // >30% null — "судья недоступен", не "всё хорошо"

const FAITHFULNESS_JUDGE_SYSTEM = `Ты — строгий проверяющий фактологической точности ответов Кузьмича, AI-хранителя туристической safety-платформы Камчатки.
Тебе даны: вопрос туриста, ПРИЛОЖЕННЫЙ КОНТЕКСТ (retrieved-данные, которые реально были в промпте Кузьмича) и ОТВЕТ Кузьмича.

Оцени FAITHFULNESS ответа по шкале 1..5: подтверждается ли КАЖДЫЙ проверяемый факт ответа (числа, статусы открыто/закрыто, опасности, расстояния, координаты, названия) приложенным контекстом.
5 — все проверяемые факты либо подтверждены контекстом, либо ответ честно говорит "нет точных данных" вместо выдумки.
3 — в целом опирается на контекст, но есть непроверяемые уточнения без явной выдумки конкретики.
1 — есть факт БЕЗОПАСНОСТИ (статус места, опасность, проходимость, сложность), которого нет в контексте и который похож на выдумку.

ОСОБО ЖЁСТКО штрафуй (максимум 2 балла) выдуманные факты БЕЗОПАСНОСТИ — на кону жизнь туриста, это не вопрос стиля текста.
Честное "у меня нет точных данных по этому" при пустом или нерелевантном контексте — это 5, НЕ штраф.

Сначала кратко рассуждай (1-2 предложения), затем верни СТРОГО JSON последней строкой:
{"score": 1-5, "reason": "<кратко>"}`;

async function judgeFaithfulness(
  question: string,
  context: string,
  answer: string,
): Promise<{ score: number | null; reason: string }> {
  const user = `ВОПРОС ТУРИСТА:
${question}

ПРИЛОЖЕННЫЙ КОНТЕКСТ (retrieved, реально был в промпте):
${context ? context.slice(0, 4000) : '(контекст пуст — retrieval ничего не нашёл по этому вопросу)'}

ОТВЕТ КУЗЬМИЧА:
${answer.slice(0, 2000)}`;

  try {
    const raw = await callAIFast([
      { role: 'system', content: FAITHFULNESS_JUDGE_SYSTEM },
      { role: 'user', content: user },
    ]);
    const score = parseJudgeScore(raw);
    return { score, reason: (raw ?? '').slice(0, 200) };
  } catch {
    return { score: null, reason: 'судья недоступен' };
  }
}

/** Fire-and-forget Telegram-алерт владельцу (образец: sendTgAlertAsync в smoke-test.ts). */
function sendTgAlertAsync(text: string): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  void fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {});
}

// ── Чистая агрегация (юнит-тестируемая, без сети/БД) ─────────────────────────

export function summarizeFaithfulness(cases: EvalCase[]): Omit<EvalReport, 'alerts_sent'> {
  const asked = cases.length;
  const scored = cases.map(c => c.score).filter((s): s is number => typeof s === 'number');
  const judged = scored.length;
  const passed = scored.filter(s => s >= PASS_MIN).length;
  const pass_rate = judged > 0 ? passed / judged : 0;
  const ci: WilsonInterval = wilsonInterval(passed, judged);
  const judge_unavailable_ratio = asked > 0 ? (asked - judged) / asked : 1;

  return {
    asked,
    judged,
    pass_rate: Math.round(pass_rate * 1000) / 1000,
    wilson_low: Math.round(ci.low * 1000) / 1000,
    wilson_high: Math.round(ci.high * 1000) / 1000,
    judge_unavailable_ratio: Math.round(judge_unavailable_ratio * 1000) / 1000,
    cases,
  };
}

/** Решает, нужен ли алерт, и с каким текстом — отдельно от вычисления отчёта (тестируемо без fetch). */
export function decideAlert(summary: Omit<EvalReport, 'alerts_sent'>): string | null {
  if (summary.asked > 0 && summary.judge_unavailable_ratio > ALERT_JUDGE_NULL_RATIO) {
    return `<b>Kuzmich Eval: судья недоступен</b>\n` +
      `Не оценено ${summary.asked - summary.judged} из ${summary.asked} вопросов ` +
      `(${Math.round(summary.judge_unavailable_ratio * 100)}%) — результат ненадёжен, это НЕ "всё хорошо".`;
  }
  if (summary.judged > 0 && summary.pass_rate < ALERT_PASS_RATE_THRESHOLD) {
    return `<b>Kuzmich Eval: faithfulness ниже порога</b>\n` +
      `Pass rate: ${(summary.pass_rate * 100).toFixed(1)}% (порог ${ALERT_PASS_RATE_THRESHOLD * 100}%), ` +
      `Wilson CI low=${summary.wilson_low}\n` +
      `Проверь retrieval/промпт Кузьмича — возможна деградация или выдуманные факты безопасности.`;
  }
  return null;
}

// ── Оркестратор (живой AI + retrieval, НЕ юнит-тестируется напрямую) ─────────

export async function runKuzmichFaithfulnessEval(opts?: { questions?: EvalQuestion[] }): Promise<EvalReport> {
  const questions = opts?.questions ?? (questionsFixture as EvalQuestion[]);
  const cases: EvalCase[] = [];

  for (const q of questions) {
    let answer: string | null = null;
    let context = '';
    try {
      const result = await askKuzmichForEval(q.question);
      answer = result?.answer ?? null;
      context = result?.context ?? '';
    } catch {
      answer = null;
    }

    if (!answer) {
      cases.push({
        id: q.id, category: q.category, question: q.question,
        answer: null, context_len: context.length, score: null,
        reason: 'нет ответа от Кузьмича (waterfall недоступен или таймаут)',
      });
      continue;
    }

    const verdict = await judgeFaithfulness(q.question, context, answer);
    cases.push({
      id: q.id, category: q.category, question: q.question,
      answer, context_len: context.length, score: verdict.score, reason: verdict.reason,
    });
  }

  const summary = summarizeFaithfulness(cases);
  const alertText = decideAlert(summary);
  if (alertText) sendTgAlertAsync(alertText);

  return { ...summary, alerts_sent: alertText !== null };
}
