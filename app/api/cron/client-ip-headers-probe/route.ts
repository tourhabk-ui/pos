/**
 * GET /api/cron/client-ip-headers-probe[?forged=1] — что прокси Timeweb
 * кладёт в заголовки адреса клиента. Bearer CRON_SECRET, только чтение, без
 * БД и без сети.
 *
 * Зачем (находка P3-02 аудита 15.10; долг 29.09 —
 * docs/mcp/audit-2026-09-29.md, «Решения владельца»). 58 роутов берут адрес
 * через `getClientIp` — первый элемент X-Forwarded-For, который пишет сам
 * клиент: перебор пароля и лимиты обходятся сменой заголовка. Починка —
 * доверенный порядок `getTrustedClientIp` (x-real-ip первым) — работает
 * только если x-real-ip ставит прокси и перезаписывает клиентский. Из
 * репозитория этого не узнать; ответ даёт запрос, прошедший настоящий прокси.
 *
 * Как звать. Дважды:
 *   1) без подделки — есть ли x-real-ip вообще и какого он рода;
 *   2) с `?forged=1` и документационными адресами (RFC 5737, например
 *      198.51.100.7) в X-Real-IP, CF-Connecting-IP и X-Forwarded-For —
 *      дошёл документационный, значит прокси пропускает клиентское.
 *
 * ЗНАЧЕНИЙ АДРЕСОВ В ОТВЕТЕ НЕТ: адрес посетителя — ПД, и даже адрес раннера
 * лишний в логе Actions. Только присутствие, число элементов, род адреса и
 * булевы сравнения (lib/security/client-ip-headers.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { describeClientIpHeaders, verdictNote } from '@/lib/security/client-ip-headers';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  forged: z.enum(['0', '1']).optional(),
});

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const parsed = QuerySchema.safeParse({
    forged: request.nextUrl.searchParams.get('forged') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Параметр forged принимает только 0 или 1' },
      { status: 400 },
    );
  }

  const report = describeClientIpHeaders(request.headers, parsed.data.forged === '1');

  return NextResponse.json({
    probe: 'client_ip_headers_v1',
    checked_at: new Date().toISOString(),
    ...report,
    note: verdictNote(report.verdict),
  });
}
