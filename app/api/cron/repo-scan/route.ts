/**
 * GET /api/cron/repo-scan
 *
 * Запускает три зонда параллельно: DB schema, GitHub repo tree, production health.
 * Результат пишется в agent_knowledge (slug='repo-scan/YYYY-MM-DD', type='repo-state').
 * Все агенты получат эти данные через readAgentBriefing() в следующем запуске.
 *
 * Auth: CRON_SECRET (Authorization: Bearer или ?secret=)
 * Запуск: .github/workflows/cron-scout.yml перед Scout-Innovator
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/auth/cron';
import { runRepoScan } from '@/lib/agents/repo-scanner';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runRepoScan();

  return NextResponse.json({
    ok: true,
    tables_scanned: result.tablesScanned,
    files_found: result.filesFound,
    endpoints_checked: result.endpointsChecked,
    generated_at: result.generatedAt,
  });
}
