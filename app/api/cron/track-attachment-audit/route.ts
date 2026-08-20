/**
 * GET /api/cron/track-attachment-audit?secret=<CRON_SECRET>[&sources=idilesom,kml_inbox]
 *
 * Пересуд уже привязанных треков сегодняшним правилом: сколько из них
 * привязка по близости больше не подтверждает.
 *
 * Зачем: треки цеплялись к маршрутам автоматически, по близости ОДНОЙ точки
 * в радиусе нескольких километров. Лог импорта 26.07 показал, чем это
 * кончается — трек «Вулкан Ичинская сопка» привязался к «Эссовским
 * термальным источникам». Правило починено, но привязки, сделанные прежним,
 * уже лежат в базе.
 *
 * Лить новые треки поверх непроверенных старых значит добавлять к неизвестной
 * ошибке ещё одну. Сначала цифры.
 *
 * READ-ONLY, под CRON_SECRET: ничего не пишет и ничего не отвязывает.
 * Решение по каждому случаю — за человеком.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runAttachmentAudit } from '@/lib/routes/track-attachment-audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('sources');
  const sources = raw
    ? raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
    : undefined;

  try {
    const audit = await runAttachmentAudit(sources);
    // v2 — пересуд больше не судит слитые и скрытые записи (фильтр в
    // runAttachmentAudit); маркер нужен пробе как датчик этого деплоя.
    return NextResponse.json({ success: true, probe: 'attach_audit_v2', ...audit });
  } catch (err) {
    // Пустой ответ читался бы как «всё чисто» — то есть как разрешение лить
    // новые треки. Отказ обязан выглядеть отказом.
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Проверка не выполнена' },
      { status: 500 },
    );
  }
}
