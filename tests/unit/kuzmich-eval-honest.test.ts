/**
 * Сторож оценки faithfulness Кузьмича: прогон обязан помещаться в отведённое
 * время и судить ответ по тому, чем ответ обоснован.
 *
 * ── Что случилось (замер 11.09 по прогонам 03.08 - 07.09) ──────────────────
 *
 * Workflow `cron-kuzmich-eval.yml` был красным ДЕСЯТЬ раз из десяти, успешных
 * прогонов в истории не было ни одного, и Watchdog четвёртые сутки повторял
 * «2 прогона подряд с отказом». Причин оказалось две, и обе не про качество
 * ответов Кузьмича:
 *
 *  1. АРИФМЕТИКА. Вопросы шли последовательно, по 14,5 с каждый (замер живого
 *     шага 07.09: 145 с на десять). Двадцать вопросов фикстуры — около 290 с
 *     при `curl --max-time 280`. Шаг падал с кодом 28 всегда, не иногда.
 *
 *  2. СУДЬЯ ПРОТИВ ПУСТОТЫ. В контекст судье уходил только поиск мест,
 *     маршрутов и законов. Ни подборка туров, ни выводы инструментов
 *     агент-цикла туда не попадали — а именно оттуда Кузьмич берёт факты
 *     безопасности. Судья по каждому вопросу писал «контекст пуст», ставил 1-2
 *     балла ХОРОШИМ ответам, pass_rate выходил 0.5, и в Telegram уходила
 *     тревога о деградации, которой не было.
 *
 * Прибор, который врёт в обе стороны, опаснее отсутствующего: он и будит зря,
 * и, если по его подсказке «починить» Кузьмича, испортит настоящие ответы.
 *
 * Сторож держит ровно эти две вещи и связывает числа между собой: вырастет
 * фикстура — арифметика покраснеет до того, как покраснеет прод.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import questionsFixture from '@/lib/agents/eval/kuzmich-eval-questions.json';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const EVAL = read('lib/agents/eval/kuzmich-faithfulness.ts');
const CORE = read('lib/kuzmich/core.ts');
const WF = read('.github/workflows/cron-kuzmich-eval.yml');

/** Замер 07.09: живой шаг отработал 10 вопросов за 145 с. */
const SEC_PER_QUESTION = 14.5;

function num(src: string, re: RegExp, what: string): number {
  const m = src.match(re);
  expect(m, `не нашёл ${what}`).toBeTruthy();
  return Number(m![1].replace(/_/g, ''));
}

describe('прогон помещается в отведённое время', () => {
  const concurrency = num(EVAL, /export const EVAL_CONCURRENCY = (\d+)/, 'EVAL_CONCURRENCY');

  it('вопросы идут пачками, а не по одному', () => {
    expect(concurrency).toBeGreaterThan(1);
    // Верхняя граница не из вкуса: прод живёт на двух ядрах (§6.1), и десятки
    // одновременных агент-циклов упрутся в провайдера и в память.
    expect(concurrency).toBeLessThanOrEqual(6);
    expect(EVAL).toMatch(/mapWithConcurrency\(questions, EVAL_CONCURRENCY/);
  });

  it('потолок ожидания больше худшего случая, а не вровень с ним', () => {
    const waits = [...WF.matchAll(/--max-time (\d+)/g)].map((m) => Number(m[1]));
    expect(waits.length, 'шаги эвала исчезли из workflow').toBeGreaterThanOrEqual(2);

    const worstCaseSec = (questionsFixture.length * SEC_PER_QUESTION) / concurrency;
    for (const w of waits) {
      // Полуторный запас: 14,5 с — средняя по одному замеру, а не гарантия.
      expect(w, `потолок ${w} с при худшем случае ${Math.round(worstCaseSec)} с`)
        .toBeGreaterThan(worstCaseSec * 1.5);
    }
  });

  it('роут объявляет бюджет не меньше, чем ждёт workflow', () => {
    const route = read('app/api/cron/kuzmich-eval/route.ts');
    const maxDuration = num(route, /maxDuration = (\d+)/, 'maxDuration роута');
    const maxWait = Math.max(...[...WF.matchAll(/--max-time (\d+)/g)].map((m) => Number(m[1])));
    expect(maxDuration).toBeGreaterThanOrEqual(maxWait);
  });
});

describe('судья видит то, чем обоснован ответ', () => {
  it('эвал собирает журнал вызовов инструментов', () => {
    expect(CORE).toMatch(/aiChatAgentLoop\(question, systemContent, \[\], \[\{ role: 'user', content: question \}\], toolRuns\)/);
  });

  it('в контекст идут туры, поиск и выводы инструментов', () => {
    const fn = CORE.slice(CORE.indexOf('export async function askKuzmichForEval'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/const context = \[toolContext, dynamic, tourContext \|\| ''\]/);
    expect(body).toMatch(/return \{ answer: cleanAIResponse\(raw\.trim\(\)\), context \}/);
  });

  it('при обрезке первым страдает каталог туров, а не выводы инструментов', () => {
    // Судья видит начало контекста. Поставь каталог вперёд — и обрезка съест
    // ровно то, чем обоснованы факты безопасности.
    const fn = CORE.slice(CORE.indexOf('export async function askKuzmichForEval'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const order = body.match(/const context = \[([^\]]+)\]/);
    expect(order, 'сборка контекста исчезла').toBeTruthy();
    expect(order![1].indexOf('toolContext')).toBeLessThan(order![1].indexOf('tourContext'));
  });

  it('инструмент без данных основанием не считается', () => {
    // «Спросили и получили пусто» ничего не обосновывает: выдать это за
    // контекст значило бы заземлить ответ отсутствием данных (§4.0).
    const fn = CORE.slice(CORE.indexOf('export async function askKuzmichForEval'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/\.filter\(r => r\.producedData && r\.output\)/);
  });

  it('вывод инструмента сохраняется обрезанным, а не целиком', () => {
    expect(CORE).toMatch(/const TOOL_OUTPUT_KEEP = \d+/);
    expect(CORE).toMatch(/output: o\.content\.slice\(0, TOOL_OUTPUT_KEEP\)/);
  });

  it('заземление судится по факту, а не по содержимому вывода', () => {
    // assessGrounding обязан остаться при своём: имя инструмента и
    // producedData. Начни он читать текст вывода — это была бы вторая,
    // расходящаяся оценка того же.
    const grounding = read('lib/agents/eval/grounding.ts');
    const fn = grounding.slice(grounding.indexOf('export function assessGrounding'));
    expect(fn.slice(0, 1500)).not.toMatch(/\.output/);
  });
});

describe('обрезка контекста не выдаётся за выдумку Кузьмича', () => {
  it('потолок контекста задан и просторен', () => {
    const limit = num(EVAL, /const JUDGE_CONTEXT_LIMIT = ([\d_]+)/, 'JUDGE_CONTEXT_LIMIT');
    expect(limit).toBeGreaterThanOrEqual(12_000);
  });

  it('сработавшая обрезка называется судье вслух', () => {
    expect(EVAL).toMatch(/КОНТЕКСТ ОБРЕЗАН нами/);
    expect(EVAL).toMatch(/Обрезка — наше ограничение, не выдумка Кузьмича/);
  });

  it('пустой контекст назван честно: ни поиск, ни инструменты', () => {
    expect(EVAL).toMatch(/ни поиск, ни инструменты ничего не принесли/);
  });
});

describe('эвал можно перезапустить, не дожидаясь понедельника', () => {
  it('маркер заведён и workflow на него смотрит', () => {
    const marker = JSON.parse(read('.github/triggers/kuzmich-eval.json')) as { run?: number };
    expect(typeof marker.run).toBe('number');
    expect(WF).toMatch(/\.github\/triggers\/kuzmich-eval\.json/);
  });

  it('расписание при этом сохранено: маркер — ручной запуск, а не второй крон', () => {
    expect(WF).toMatch(/- cron: '0 5 \* \* 1'/);
  });
});
