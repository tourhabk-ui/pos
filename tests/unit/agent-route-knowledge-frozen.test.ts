/**
 * `agent_route_knowledge` в новом коде не появляется (CLAUDE.md §4.1).
 *
 * С миграции 663 это VIEW: UNION ALL `places` + `kamchatka_routes`, запись
 * через INSTEAD OF триггеры. Правило запрещает обращаться к ней в НОВОМ коде:
 * читать и писать надо master-таблицы. Внутренний аудит 02.10 нашёл, что
 * правило держалось только абзацем — сторожа не было, и новый файл с
 * `FROM agent_route_knowledge` прошёл бы CI молча.
 *
 * Нынешние 47 файлов заморожены: переписывать их скопом на рабочем VIEW —
 * риск регрессий без выигрыша для туриста. Список может только сокращаться:
 * файл, переставший обращаться к VIEW, тест требует убрать (самоустаревание,
 * как KNOWN_UNPRODUCED). Прямой INSERT в VIEW запрещён без исключений.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOTS = ['app', 'lib', 'components'];
const REF = /\b(INSERT\s+INTO|UPDATE|FROM|JOIN)\s+agent_route_knowledge\b/i;
const INSERT = /\bINSERT\s+INTO\s+agent_route_knowledge\b/i;

const KNOWN_READERS = new Set<string>([
  'app/api/admin/audit-knowledge/route.ts',
  'app/api/admin/content/routes/[id]/route.ts',
  'app/api/admin/content/routes/bulk/route.ts',
  'app/api/admin/content/routes/route.ts',
  'app/api/admin/enrich-routes/route.ts',
  'app/api/admin/generate-images/route.ts',
  'app/api/cron/alert-scope-census/route.ts',
  'app/api/cron/catalog-diag/route.ts',
  'app/api/cron/editor-result/route.ts',
  'app/api/cron/planner-material-census/route.ts',
  'app/api/cron/retrieval-probe/route.ts',
  'app/api/cron/safety-ingest/route.ts',
  'app/api/home/metrics/route.ts',
  'app/api/operators/[slug]/routes/route.ts',
  'app/api/planner/tours-for-day/route.ts',
  'app/api/public/stats/categories/route.ts',
  'app/api/public/stats/route.ts',
  'app/api/routes/[id]/export/route.ts',
  'app/api/routes/[id]/offline-bundle/route.ts',
  'app/api/routes/[id]/route.ts',
  'app/api/routes/analysis/route.ts',
  'app/api/routes/by-region/route.ts',
  'app/api/routes/nearby/route.ts',
  'app/api/safety/alerts/route.ts',
  'app/api/safety/capacity/route.ts',
  'app/api/safety/routes/route.ts',
  'app/api/safety/warnings/route.ts',
  'app/api/search/route.ts',
  'app/api/telegram/webhook/route.ts',
  'app/api/tools/equipment/route.ts',
  'app/routes/[id]/page.tsx',
  'components/routes/CategoryPage.tsx',
  'lib/agents/agencies/danger-analyst-agency.ts',
  'lib/agents/context-hub.ts',
  'lib/agents/editor.ts',
  'lib/agents/eval/editor-regression.ts',
  'lib/ai/embeddings.ts',
  'lib/ai/rag-context.ts',
  'lib/kuzmich/core.ts',
  'lib/notifications/post-validation.ts',
  'lib/notifications/telegram-channel.ts',
  'lib/planner/data.ts',
  'lib/planner/engine.ts',
  'lib/routes/catalog-query.ts',
  'lib/routes/catalog-sitemap.ts',
  'lib/services/ingest/ai-image-generator.ts',
  'lib/stats/platform-counts.ts',
]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
}

const files: string[] = [];
for (const r of ROOTS) walk(r, files);
const referencing = files.filter((f) => REF.test(readFileSync(f, 'utf8')));

describe('agent_route_knowledge: замороженный список читателей', () => {
  it('новый файл не обращается к VIEW — только places / kamchatka_routes', () => {
    const fresh = referencing.filter((f) => !KNOWN_READERS.has(f));
    expect(fresh).toEqual([]);
  });
  it('список самоустаревает: файл без обращения убирается из KNOWN_READERS', () => {
    const stale = [...KNOWN_READERS].filter((f) => !referencing.includes(f));
    expect(stale).toEqual([]);
  });
  it('прямого INSERT в VIEW нет нигде', () => {
    const inserts = files.filter((f) => INSERT.test(readFileSync(f, 'utf8')));
    expect(inserts).toEqual([]);
  });
});
