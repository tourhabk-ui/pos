/**
 * Оценки ответов Кузьмича не доходят до туриста.
 *
 * ── Что случилось 20.09 ───────────────────────────────────────────────────
 *
 * Живой вызов `get_place_info` про озеро вернул среди фактов о месте строку
 * «Оценка ответа: 6/10: Вопрос: Цены на туры... Проблемы: неполная
 * информация о ценах». Это служебная запись kuzmich-outcomes — телеметрия
 * КАЧЕСТВА ответов, совпавшая по ILIKE с запросом.
 *
 * Тот же дефект уже разбирался 15.08 (проба 113) и был починен в
 * guardian-context условием `type <> 'outcome'`. Но копий запроса к
 * agent_knowledge три, а фильтр стоял в одной: вторая отдаёт факты о месте,
 * третья набивает контекст промпта пятьюдесятью свежими записями. Копии
 * разошлись молча — ровно то, из-за чего в этом проекте факты сводят в один
 * модуль.
 *
 * Сторож проверяет ИСХОДНИКИ всех трёх запросов: до базы тест не ходит, а
 * забытое условие видно в SQL.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const core = readFileSync(join(ROOT, 'lib/kuzmich/core.ts'), 'utf-8');
const guardian = readFileSync(join(ROOT, 'lib/kuzmich/guardian-context.ts'), 'utf-8');

/** Каждый SELECT из agent_knowledge в файле — от FROM до LIMIT. */
function knowledgeQueries(src: string): string[] {
  const out: string[] = [];
  let from = src.indexOf('FROM agent_knowledge');
  while (from !== -1) {
    const limit = src.indexOf('LIMIT', from);
    out.push(src.slice(from, limit === -1 ? from + 400 : limit));
    from = src.indexOf('FROM agent_knowledge', from + 1);
  }
  return out;
}

describe('ни один читающий запрос не берёт оценки', () => {
  it('в core.ts все выборки из agent_knowledge отсекают type = outcome', () => {
    // Выборка get_place_info с 25.09 — в lib/kuzmich/place-info-tool: считаем
    // её вместе с core, иначе порог «не меньше двух» ослеп бы от переезда.
    const placeInfo = readFileSync(join(ROOT, 'lib/kuzmich/place-info-tool.ts'), 'utf-8');
    const qs = [...knowledgeQueries(core), ...knowledgeQueries(placeInfo)];
    expect(qs.length).toBeGreaterThanOrEqual(2);
    for (const q of qs) {
      expect(q, `запрос без фильтра: ${q.slice(0, 120)}`).toMatch(/type\s*<>\s*'outcome'/);
    }
  });

  it('в guardian-context фильтр на месте — он и был первым', () => {
    for (const q of knowledgeQueries(guardian)) {
      expect(q).toMatch(/type\s*<>\s*'outcome'/);
    }
  });

  it('запись оценок по-прежнему идёт: чинилось чтение, не запись', () => {
    // INSERT с type='search_result' и путь kuzmich-outcomes не трогаем —
    // телеметрия нужна, она просто не для глаз туриста.
    expect(core).toMatch(/INSERT INTO agent_knowledge/);
  });
});
