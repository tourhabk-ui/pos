/**
 * POST /api/mcp/partner/oauth/authorize — партнёр нажал «Разрешить» на
 * экране согласия (/oauth/partner/authorize). Ответ — адрес, куда браузер
 * уходит с одноразовым кодом: Claude заберёт код и обменяет его на токен.
 *
 * «Отказать» сюда не ходит: экран согласия ведёт на адрес возврата с
 * `error=access_denied` сам — отказ не требует ни входа, ни базы.
 *
 * Защита от подделки запроса с чужого сайта — тремя слоями:
 *  - кука входа SameSite=Lax: межсайтовый POST её не несёт;
 *  - Origin обязан быть этим сайтом;
 *  - тело — только application/json: такой запрос с чужого сайта браузер
 *    без CORS-разрешения не отправит, а CORS здесь не открыт.
 * Запрос подключения проверяется заново той же функцией, что у экрана
 * (checkAuthorizeRequest): страница могла быть открыта давно или подделана.
 *
 * Edge пропускает префикс /api/mcp без JWT (middleware.ts не тронут) —
 * вход проверяет requirePartner здесь, как у всех роутов CRM.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { checkAuthorizeRequest, redirectWith } from '@/lib/crm/partner-oauth-request';
import { issueAuthorizationCode } from '@/lib/crm/partner-oauth';
import { OAUTH_ISSUER } from '@/lib/crm/partner-oauth-public';

export const dynamic = 'force-dynamic';

const param = z.string().max(2048).optional().nullable();
const DecisionSchema = z.object({
  response_type: param,
  client_id: param,
  redirect_uri: param,
  code_challenge: param,
  code_challenge_method: param,
  state: param,
  scope: param,
  resource: param,
  // По умолчанию — только чтение (условие владельца для MCP партнёра).
  can_write: z.boolean().optional().default(false),
}).strict();

/**
 * Origin запроса — этот же сайт. Хост — из заголовка прокси, как у
 * Edge-редиректов; канон сайта принимается и без него: за прокси Timeweb
 * `host` бывает внутренним, и честный партнёр не должен получить 403 из-за
 * того, что прокси не прислал x-forwarded-host.
 */
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  if (origin === OAUTH_ISSUER) return true;
  try {
    const host = new URL(origin).host;
    return host === req.headers.get('x-forwarded-host') || host === req.headers.get('host');
  } catch {
    return false;
  }
}

function refuse(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error }, { status });
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return refuse('Запрос не с сайта Ведара', 403);
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
    return refuse('Ожидается JSON', 415);
  }

  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;

  const body: unknown = await req.json().catch(() => null);
  const parsed = DecisionSchema.safeParse(body);
  if (!parsed.success) return refuse('Некорректные данные подключения', 400);

  const check = checkAuthorizeRequest(parsed.data);
  if (check.kind === 'fatal') return refuse(check.message, 400);
  if (check.kind === 'error') return NextResponse.json({ success: true, data: { redirect: check.redirect } });

  const { request } = check;
  try {
    const code = await issueAuthorizationCode({
      partnerId: ctx.partnerId,
      userId: ctx.userId,
      clientId: request.client.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      // Запись — только если клиент её просил И партнёр её отметил.
      canWrite: request.wantsWrite && parsed.data.can_write,
    });
    return NextResponse.json({
      success: true,
      data: { redirect: redirectWith(request.redirectUri, { code, state: request.state }) },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[partner-oauth] код авторизации не выдан, SQLSTATE', code);
    return refuse('Не удалось подключить — попробуйте ещё раз через минуту', 503);
  }
}
