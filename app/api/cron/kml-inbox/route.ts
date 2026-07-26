/**
 * POST /api/cron/kml-inbox — приём одного KML-трека от workflow.
 *
 * Файлы лежат в data/tracks-inbox/ репозитория; workflow data-kml-inbox.yml
 * постит их сюда по одному с Bearer CRON_SECRET (паттерн osm-import: прод
 * видит БД нативно, раннер — нет). Импорт детерминированный, без LLM.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { importKmlTrack } from '@/lib/import/kml-inbox';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const KmlInboxSchema = z.object({
  filename: z.string().min(1).max(200),
  kml: z.string().min(20).max(2_000_000, 'KML больше 2 МБ — не трек, а свалка'),
});

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = KmlInboxSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  try {
    const outcome = await importKmlTrack(parsed.data.filename, parsed.data.kml);
    return NextResponse.json({ success: true, ...outcome });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Ошибка импорта KML' },
      { status: 500 },
    );
  }
}
