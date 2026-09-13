/**
 * POST /api/cron/place-description-drafts-review — #1830, шаг 3 (ревью),
 * когда решение по каждому черновику уже принято ЧЕЛОВЕКОМ (или явным
 * поручением человека — «сам делай ревью», 13.09) и осталось только
 * исполнить его на проде без входа в админку.
 *
 * Делает РОВНО то же, что `PATCH /api/admin/places/[id]/description-draft`
 * (Zod approve/reject, публикация только из 'pending', только approve пишет
 * `places.description`) — та же логика, второй вход для CRON_SECRET вместо
 * admin-JWT, по прецеденту других `/api/admin/*`-ручек, которые дёргает
 * workflow (`app/api/admin/leads/list/route.ts` и соседи: CRON_SECRET ИЛИ
 * requireAdmin). Здесь отдельный роут, а не тот же файл: `/api/admin/*`
 * закрыт на Edge под CRON_SECRET только в заголовке `Authorization: Bearer`
 * (`middleware.ts`), а секрет пробы (`probe-url.yml`) подставляется
 * автоматически ТОЛЬКО для `/api/cron/*` — класть его в committed
 * `probe-url.json` руками запрещено (файл публичный, секрет утёк бы в
 * историю). `/api/cron/*` уже прошёл этот путь для других ручек этой же
 * фичи (`place-coords`, `place-description-drafts` сам) — тот же периметр.
 *
 * Решение не выдумывается роутом: массив `decisions` явный, без дефолтов и
 * без «одобрить всё, что pending» — каждая запись называет свой place_id и
 * свой action.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyCronSecret } from '@/lib/auth/cron';
import { query, transaction } from '@/lib/database';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  decisions: z.array(z.object({
    place_id: z.string().min(1),
    action: z.enum(['approve', 'reject']),
  })).min(1).max(50),
});

interface DecisionOutcome {
  place_id: string;
  action: 'approve' | 'reject';
  status: 'applied' | 'not_found' | 'already_reviewed';
  previous_status?: string;
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: 'Неверный JSON' }, { status: 400 });

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const outcomes: DecisionOutcome[] = [];

  for (const { place_id, action } of parsed.data.decisions) {
    const draftResult = await query<{ translated_text: string; status: string }>(
      `SELECT translated_text, status FROM place_description_drafts WHERE place_id = $1 AND source = 'gvp'`,
      [place_id],
    );
    if (draftResult.rows.length === 0) {
      outcomes.push({ place_id, action, status: 'not_found' });
      continue;
    }
    if (draftResult.rows[0].status !== 'pending') {
      outcomes.push({ place_id, action, status: 'already_reviewed', previous_status: draftResult.rows[0].status });
      continue;
    }

    const finalText = draftResult.rows[0].translated_text;

    await transaction(async (client) => {
      await client.query(
        `UPDATE place_description_drafts
            SET status = $2, reviewed_at = NOW(), translated_text = $3
          WHERE place_id = $1 AND source = 'gvp'`,
        [place_id, action === 'approve' ? 'approved' : 'rejected', finalText],
      );

      if (action === 'approve') {
        await client.query(
          `UPDATE places SET description = $2, updated_at = NOW() WHERE id = $1`,
          [place_id, finalText],
        );
      }
    });

    outcomes.push({ place_id, action, status: 'applied' });
  }

  return NextResponse.json({
    success: true,
    probe: 'place_description_drafts_review_v1',
    total: outcomes.length,
    applied: outcomes.filter(o => o.status === 'applied').length,
    outcomes,
  });
}
