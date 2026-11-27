/**
 * GET|POST /api/cron/gigachat-check[?q=…] — проверка ключа GigaChat
 * и один вопрос модели с прода (российский IP Timeweb). Freemium API
 * без веб-поиска: смотрим, упоминает ли ответ Ведар.
 *
 * Защита та же, что у остальных кронов: Authorization: Bearer CRON_SECRET
 * (разбор — в lib/auth/cron.ts). Ключ и access_token в ответ и логи
 * не попадают; ошибки — только код/статус.
 *
 * Эндпоинт стоит под /api/cron, а не /api/internal: на Edge префикс
 * /api/cron уже в PUBLIC_API_ROUTES (проверка внутри), а Bearer с
 * CRON_SECRET на чужом префиксе middleware принял бы за JWT.
 */
import { NextRequest, NextResponse } from 'next/server';
import { diagnoseCronAuth, verifyCronSecret } from '@/lib/auth/cron';
import { runGigachatCheck } from '@/lib/gigachat/client';
import { clampQuestion, DEFAULT_QUESTION } from '@/lib/gigachat/parse';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const PROBE = 'gigachat_check_v1';

async function questionFrom(request: NextRequest): Promise<string> {
  const fromQuery = request.nextUrl.searchParams.get('q');
  if (fromQuery && fromQuery.trim()) return clampQuestion(fromQuery);
  if (request.method === 'POST') {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const body = (await request.json().catch(() => null)) as { q?: unknown } | null;
      if (body && typeof body.q === 'string') return clampQuestion(body.q);
    }
  }
  return DEFAULT_QUESTION;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json(
      { ok: false, probe: PROBE, error: 'Unauthorized', ...diagnoseCronAuth(request) },
      { status: 401 },
    );
  }
  const question = await questionFrom(request);
  const result = await runGigachatCheck(question);
  return NextResponse.json(result.body, { status: result.status });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
