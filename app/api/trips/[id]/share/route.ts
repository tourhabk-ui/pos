import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { attachMcpAttribution, MCP_ATTRIBUTION } from '@/lib/mcp/handoff';
import { getPublicBaseUrl } from '@/lib/config';

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
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
