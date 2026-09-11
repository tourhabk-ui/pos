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
import { tgSend } from '@/lib/notifications/tg-send';
import { judgeWithFallback } from '@/lib/agents/eval/editor-judge';
import { wilsonInterval, type WilsonInterval } from '@/lib/agents/learning/experiment-tracker';
import questionsFixture from '@/lib/agents/eval/kuzmich-eval-questions.json';

export interface EvalQuestion {
  id: string;
  // 'live' — вопрос, сэмплированный из реальных chat_sessions (см.
  // lib/agents/eval/live-questions.ts): модели различают тестовый и живой
  // контекст, фикстура может систематически получать более аккуратные ответы.
  category: 'route' | 'safety' | 'season' | 'logistics' | 'live';
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

/**
 * Сколько вопросов идёт одновременно.
 *
 * Прогон был последовательным, и это не помещалось в отведённое время:
 * замер 07.09 по живому шагу — 145 с на десять вопросов, то есть 14,5 с на
 * вопрос (ответ Кузьмича через агент-цикл плюс судья). Двадцать вопросов
 * фикстуры дают около 290 с при потолке curl в 280 — шаг падал с кодом 28
 * КАЖДЫЙ раз, и «успешных прогонов в истории нет» было арифметикой, а не
 * регрессией ответов.
 *
 * Четыре — не потолок провайдера, а осознанная умеренность: прод живёт на
 * двух ядрах (§6.1), и вопросы ждут сеть, а не считают. Двадцать вопросов
 * укладываются примерно в 75 с.
 */
export const EVAL_CONCURRENCY = 4;

/**
 * Потолок контекста, показываемого судье.
 *
 * Обрезка тут не экономия, а риск: факт, вырезанный из контекста, судья
 * объявит невернифицируемым, и мы получим низкий балл за СВОЮ обрезку.
 *
 * ПЕРВАЯ РЕДАКЦИЯ СТАВИЛА 12 000 «с запасом» — и запас был выдуман, а не
 * измерен. Первый же зелёный прогон (11.09, run 11) показал настоящий размер:
 * от 25 317 до 28 487 символов во ВСЕХ тридцати вопросах. То есть судья видел
 * меньше половины материала, оговорка об обрезке срабатывала на каждом
 * вопросе, и pass_rate фикстуры вышел 0.1. Цифра, поставленная по догадке
 * рядом с измеримой величиной, — это та же болезнь, что чинил сам прогон.
 *
 * 40 000 взяты ОТ ЗАМЕРА: полуторный запас к худшему наблюдённому случаю.
 * На DeepSeek это порядка 10 тысяч входных токенов на вопрос — копейки при
 * недельном прогоне из тридцати вопросов. Оговорка об обрезке остаётся: она
 * теперь редкое событие, а не постоянный фон.
 */
const JUDGE_CONTEXT_LIMIT = 40_000;

/**
 * Выполняет задачи пачками по `limit`, сохраняя порядок результатов.
 * Свой на четыре строки, чтобы не тащить зависимость ради одного места.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

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
  const truncated = context.length > JUDGE_CONTEXT_LIMIT;
  const shown = truncated ? context.slice(0, JUDGE_CONTEXT_LIMIT) : context;

  const user = `ВОПРОС ТУРИСТА:
${question}

ПРИЛОЖЕННЫЙ КОНТЕКСТ (данные и выводы инструментов, реально бывшие в промпте Кузьмича):
${shown || '(контекст пуст — ни поиск, ни инструменты ничего не принесли по этому вопросу)'}${
  truncated
    ? `\n\n(КОНТЕКСТ ОБРЕЗАН нами: показано ${JUDGE_CONTEXT_LIMIT} из ${context.length} символов. Обрезка — наше ограничение, не выдумка Кузьмича: факт, которого нет в показанной части, мог лежать в отрезанной. Снижай балл за факт, ПРОТИВОРЕЧАЩИЙ показанному, либо за конкретику по теме, которой в контексте нет вовсе.)`
    : ''
}

ОТВЕТ КУЗЬМИЧА:
${answer.slice(0, 2000)}`;

  // Судья с фоллбэком провайдера: быстрый набор, при недоступности — полный
  // waterfall (Anthropic и др.). «судья недоступен» ставится, только если ОБА
  // набора не дали балла — не из-за единичного отказа одного провайдера.
  return judgeWithFallback(FAITHFULNESS_JUDGE_SYSTEM, user);
}

/** Fire-and-forget Telegram-алерт владельцу (образец: sendTgAlertAsync в smoke-test.ts). */

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

  // Порядок результатов сохраняется: отчёт читают глазами, и случайный
  // порядок вопросов сделал бы два прогона несравнимыми.
  const cases: EvalCase[] = await mapWithConcurrency(questions, EVAL_CONCURRENCY, async (q) => {
    let answer: string | null = null;
    let context = '';
    try {
      const result = await askKuzmichForEval(q.question);
      answer = result?.answer ?? null;
      context = result?.context ?? '';
    } catch (err) {
      // Отказ не глушится (§4.0): без строки в логе «нет ответа от Кузьмича»
      // неотличимо от «Кузьмич промолчал по делу».
      console.error('[kuzmich-eval] вопрос не отработал', {
        id: q.id,
        message: err instanceof Error ? err.message : String(err),
      });
      answer = null;
    }

    if (!answer) {
      return {
        id: q.id, category: q.category, question: q.question,
        answer: null, context_len: context.length, score: null,
        reason: 'нет ответа от Кузьмича (waterfall недоступен или таймаут)',
      };
    }

    const verdict = await judgeFaithfulness(q.question, context, answer);
    return {
      id: q.id, category: q.category, question: q.question,
      answer, context_len: context.length, score: verdict.score, reason: verdict.reason,
    };
  });

  const summary = summarizeFaithfulness(cases);
  const alertText = decideAlert(summary);
  // `alerts_sent` теперь означает ДОСТАВЛЕНО, а не «решили тревожить».
  // Прежде здесь стояло `alertText !== null`: недоставленная тревога
  // записывалась как отправленная (находка аудита 08.09).
  const delivery = alertText ? await tgSend('kuzmich-eval', alertText) : null;

  return { ...summary, alerts_sent: delivery?.ok === true };
}
