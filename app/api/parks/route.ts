/**
 * GET /api/parks
 * Публичный. Список активных природных парков (справочник parks, migration 712).
 */
import { NextResponse } from 'next/server';
import { listActiveParks } from '@/lib/parks/list';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ success: true, parks: await listActiveParks() });
  } catch (err) {
    console.error('[api/parks] список парков не прочитан:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ success: false, error: 'Ошибка загрузки парков' }, { status: 500 });
  }
}
