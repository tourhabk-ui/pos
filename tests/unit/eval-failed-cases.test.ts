/**
 * Проваленные проверки Кузьмича попадают в ЗАПИСЬ прогона, а не только в лог.
 *
 * Побочная находка #1883 (14.09), и она дороже, чем выглядит. Сегодняшний
 * дефект — Кузьмич выдумывает километраж до города — нашёлся тем, что человек
 * полез в Actions API и распарсил лог конкретного прогона. Ни тревога, ни
 * запись в БД не несли ничего, кроме агрегата: «pass_rate 75%» не говорит,
 * КАКИЕ вопросы упали и чем именно.
 *
 * То есть диагностика существовала, но в месте, куда никто не смотрит. Число
 * без объяснения зовёт разбираться, не сказав куда, — тот же род, что «причина
 * пропуска не записана» в этом же файле.
 *
 * ПД ЖИВОГО ТРАФИКА. При `source=live` вопрос — сообщение живого туриста, и
 * класть его в базу дословно нельзя (§8, D1). Текст идёт через `redactPII` —
 * тот же инструмент, что чистит промпты перед отправкой в зарубежные модели.
 * Ветка одна на оба источника намеренно: две разошлись бы, и разошлись бы
 * молча — в сторону «живые вопросы легли как есть».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { failedCases, type EvalCase } from '@/lib/agents/eval/kuzmich-faithfulness';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/kuzmich-eval/route.ts'), 'utf-8');

function makeCase(over: Partial<EvalCase>): EvalCase {
  return {
    id: 'x', category: 'logistics', question: 'q', answer: 'a',
    context_len: 10, score: 5, reason: 'ok', ...over,
  };
}

describe('отбор проваленных', () => {
  it('берёт балл ниже порога И отсутствие балла — это разные беды, обе нужны', () => {
    // score = null значит «судья не ответил» (третий исход §4.0). Он не равен
    // «проверили, плохо», но в разбор попасть обязан: молчащий судья — тоже
    // повод смотреть.
    const out = failedCases([
      makeCase({ id: 'pass', score: 5 }),
      makeCase({ id: 'edge', score: 4 }),
      makeCase({ id: 'bad', score: 2 }),
      makeCase({ id: 'silent', score: null }),
    ]);
    expect(out.map(c => c.id)).toEqual(['bad', 'silent']);
  });

  it('успешный прогон даёт пустой список, а не отсутствие поля', () => {
    expect(failedCases([makeCase({ score: 5 })])).toEqual([]);
  });

  it('потолок есть: запись прогона не должна расти без предела', () => {
    const many = Array.from({ length: 20 }, (_, i) => makeCase({ id: `c${i}`, score: 1 }));
    expect(failedCases(many).length).toBeLessThanOrEqual(8);
  });

  it('обоснование судьи обрезается — полный текст нужен глазам, не базе', () => {
    const long = 'ю'.repeat(2000);
    const [c] = failedCases([makeCase({ score: 1, reason: long })]);
    expect(c.reason.length).toBeLessThanOrEqual(400);
  });
});

describe('персональные данные не ложатся в базу дословно', () => {
  it('вопрос и обоснование чистятся redactPII', () => {
    const [c] = failedCases([makeCase({
      score: 1,
      question: 'Напишите мне на ivan@example.com или +7 900 123-45-67',
      reason: 'турист оставил ivan@example.com',
    })]);
    expect(c.question).not.toContain('ivan@example.com');
    expect(c.question).not.toContain('900');
    expect(c.reason).not.toContain('ivan@example.com');
  });

  it('чистка одна на оба источника — две ветки разошлись бы молча', () => {
    const src = readFileSync(join(process.cwd(), 'lib/agents/eval/kuzmich-faithfulness.ts'), 'utf-8');
    const at = src.indexOf('export function failedCases');
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body).not.toMatch(/source\s*===\s*'live'/);
    expect(body).toContain('redactPII(c.question)');
    expect(body).toContain('redactPII(c.reason)');
  });
});

describe('попадает в запись прогона', () => {
  it('кладётся в metadata успешного прогона, где лежат агрегаты', () => {
    expect(ROUTE).toMatch(/failed_cases: failedCases\(report\.cases\)/);
  });

  it('импортировано из того же модуля, что и сам прогон', () => {
    expect(ROUTE).toMatch(/import \{ runKuzmichFaithfulnessEval, failedCases \}/);
  });
});
