import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { attachMcpAttribution, MCP_ATTRIBUTION } from '@/lib/mcp/handoff';
import { getPublicBaseUrl } from '@/lib/config';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Отказ базы — в лог с SQLSTATE, человеку — общие слова (§4.0, аудит 07.11 H11). */
function failed(what: string, err: unknown, message: string): NextResponse {
  const e = err as { code?: unknown; message?: unknown };
  console.error(`[trips/share] ${what}:`, typeof e?.code === 'string' ? e.code : 'нет SQLSTATE', typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authOrResponse = await requireAuth(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;
  const { userId } = authOrResponse;
  const { id } = await params;

  try {
    const { rows } = await pool.query<{ share_token: string }>(
      `UPDATE user_trips
       SET is_public = TRUE
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING share_token`,
      [id, userId]
    );

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    }

    // Атрибуция MCP-handoff (v2, #60): план, начатый по ссылке агента,
    // дошёл до «поделиться». Только UUID handoff-а из проверенной cookie.
    await attachMcpAttribution(
      request.cookies.get(MCP_ATTRIBUTION.cookieName)?.value,
      'plan_shared',
    );

    const shareToken = rows[0].share_token;
    const baseUrl = getPublicBaseUrl();
    return NextResponse.json({
      success: true,
      shareToken,
      shareUrl: `${baseUrl}/trip/${shareToken}`,
    });
  } catch (err) {
    return failed('публикация не записана', err, 'Ссылка сейчас не создалась — попробуйте ещё раз');
  }
}

/**
 * Закрыть ссылку (аудит 07.11, H15). До этого публикацию нельзя было отозвать:
 * переслал ссылку не тому — план открыт навсегда. Токен меняется: старая
 * ссылка перестаёт открывать план сразу, а новое «Поделиться» даст новую
 * ссылку, а не вернёт доступ тем, у кого осталась прежняя.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authOrResponse = await requireAuth(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;
  const { userId } = authOrResponse;
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  try {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE user_trips
       SET is_public = FALSE, share_token = gen_random_uuid()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [id, userId]
    );
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return failed('публикация не снята', err, 'Ссылку сейчас не закрыть — попробуйте ещё раз');
  }
}
