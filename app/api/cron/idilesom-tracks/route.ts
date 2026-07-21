/**
 * GET /api/cron/idilesom-tracks?secret=<CRON_SECRET>&limit=20
 *
 * Backfill GPS-треков из idilesom.com для уже импортированных мест.
 * Первичный импорт клал трек только для новых мест — задедупленные
 * остались без geometry (кейс «Гора Замок»). Запускается с прод-сервера
 * (idilesom доступен с IP Timeweb), дергается workflow'ом
 * import-idilesom-tracks.yml партиями до remaining=0.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { backfillIdilesomTracks, linkIdilesomTracksToPlaces } from '@/lib/services/ingest/idilesom-importer';
import { logAgentRun } from '@/lib/agents/run-logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // mode=link: пост-проход — привязка уже записанных треков к местам по имени
  // и близости места к любой точке трека (backfill матчит только старт трека)
  if (request.nextUrl.searchParams.get('mode') === 'link') {
    const startedLink = new Date();
    try {
      const result = await linkIdilesomTracksToPlaces();
      void logAgentRun({
        agent_id: 'idilesom-tracks-link',
        status: 'success',
        started_at: startedLink,
        duration_ms: result.duration_ms,
        metadata: result as unknown as Record<string, unknown>,
      });
      return NextResponse.json({ success: true, mode: 'link', ...result });
    } catch (err) {
      void logAgentRun({
        agent_id: 'idilesom-tracks-link',
        status: 'failed',
        started_at: startedLink,
        duration_ms: Date.now() - startedLink.getTime(),
        errors_count: 1,
        error_msg: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Ошибка привязки треков' },
        { status: 500 },
      );
    }
  }

  const limitRaw = parseInt(request.nextUrl.searchParams.get('limit') ?? '10', 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 10, 1), 25);
  const offsetRaw = parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10);
  const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);
  const startedAt = new Date();

  try {
    const result = await backfillIdilesomTracks(limit, offset);

    void logAgentRun({
      agent_id: 'idilesom-tracks',
      status: result.errors === 0 ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: result.duration_ms,
      metadata: result as unknown as Record<string, unknown>,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'idilesom-tracks',
      status: 'failed',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      errors_count: 1,
      error_msg: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ошибка backfill' },
      { status: 500 },
    );
  }
}
