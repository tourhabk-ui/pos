/**
 * Записи agent_knowledge, у которых заголовок — сообщение туриста, наружу не
 * уходят (проверка MCP 29.09, 152-ФЗ).
 *
 * Кузьмич сам копит в agent_knowledge два рода из разговоров с людьми:
 * search_result (заголовок — userContent дословно) и auto_gap (тема из
 * вопросов туристов, при отказе дедупа — сам вопрос). Три читателя отсекали
 * только outcome, и совпадение по ILIKE отдавало чужой вопрос анонимному
 * MCP-клиенту, а пятьдесят свежих таких строк шли в промпт каждого чата.
 *
 * Сторож держит связку, а не половину:
 *   - всякий запрос к agent_knowledge в lib/kuzmich и на MCP-пути идёт через
 *     KUZMICH_KNOWLEDGE_SCOPE_SQL — новый читатель попадает под правило сам;
 *   - в разрешённом списке нет родов, которые пишутся из разговоров, и эти
 *     писатели существуют (иначе запрет стал бы объявлением без источника);
 *   - оба писателя чистят ПД до записи — вторая стена для хранения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KUZMICH_KNOWLEDGE_TYPES, KUZMICH_KNOWLEDGE_SCOPE_SQL } from '@/lib/kuzmich/knowledge-scope';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Роды, которые пишутся из разговоров с людьми, — писатель и признак. */
const CONVERSATION_KINDS: Array<{ type: string; writer: string }> = [
  { type: 'search_result', writer: 'lib/kuzmich/core.ts' },
  { type: 'auto_gap', writer: 'app/api/cron/kb-gap/route.ts' },
  { type: 'outcome', writer: 'lib/agents/managed/kuzmich-outcomes.ts' },
];

/** Каждый SELECT из agent_knowledge в исходнике — от FROM до LIMIT. */
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

const READER_FILES = [
  ...readdirSync(join(ROOT, 'lib/kuzmich')).filter((f) => f.endsWith('.ts')).map((f) => `lib/kuzmich/${f}`),
  ...readdirSync(join(ROOT, 'lib/mcp')).filter((f) => f.endsWith('.ts')).map((f) => `lib/mcp/${f}`),
  'app/api/mcp/route.ts',
];

describe('разрешённый список родов знания Кузьмича', () => {
  it('роды из разговоров в список не входят, и их писатели существуют', () => {
    for (const k of CONVERSATION_KINDS) {
      expect(KUZMICH_KNOWLEDGE_TYPES as readonly string[], k.type).not.toContain(k.type);
      expect(read(k.writer), `писатель ${k.type} исчез — обнови список`).toMatch(new RegExp(`'${k.type}'`));
    }
  });

  it('SQL-область строится из списка и называет только его', () => {
    expect(KUZMICH_KNOWLEDGE_SCOPE_SQL).toMatch(/^agent_id = 'kuzmich' AND type IN \(/);
    const listed = [...KUZMICH_KNOWLEDGE_SCOPE_SQL.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).slice(1);
    expect(listed).toEqual([...KUZMICH_KNOWLEDGE_TYPES]);
  });

  it('все выборки из agent_knowledge на путях Кузьмича и MCP идут через область', () => {
    const queries = READER_FILES.flatMap((f) => knowledgeQueries(read(f)).map((q) => ({ f, q })));
    // Три читателя на 29.09: промпт чата, get_place_info, get_guardian_context.
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const { f, q } of queries) {
      expect(q, `${f}: выборка мимо разрешённого списка: ${q.slice(0, 120)}`).toMatch(/\$\{KUZMICH_KNOWLEDGE_SCOPE_SQL\}/);
    }
  });
});

describe('писатели чистят ПД до записи', () => {
  it('saveSearchResultToKB: заголовок и slug — из redactPII(userContent)', () => {
    const core = read('lib/kuzmich/core.ts');
    const fn = core.slice(core.indexOf('async function saveSearchResultToKB'), core.indexOf('// ── Level 2'));
    expect(fn).toMatch(/const query = redactPII\(rawQuery\)/);
    expect(fn).not.toMatch(/catch\(\(\) => \{\}\)/);
  });

  it('kb-gap: вопрос туриста чистится до дедупа, поиска и записи', () => {
    const gap = read('app/api/cron/kb-gap/route.ts');
    expect(gap).toMatch(/unknownQuestions\.push\(redactPII\(userMsg\.content\)/);
    expect(gap).toMatch(/if \(stored\) saved\.push\(topic\)/);
  });

  it('kb-gap не печатает темы в ответ — он уходит в лог GitHub Actions', () => {
    const gap = read('app/api/cron/kb-gap/route.ts');
    const body = gap.slice(gap.lastIndexOf('return NextResponse.json({'));
    expect(body).toMatch(/topics_saved: saved\.length/);
    expect(body).not.toMatch(/\btopics: saved\b/);
  });
});
