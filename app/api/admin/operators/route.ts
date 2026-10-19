/**
 * GET /api/admin/operators — очередь заявок операторов
 * Возвращает partners с profile_status + данные из operator_applications
 */

import { lastPartnerDeliveries } from '@/lib/leads/delivery-outcome';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { z } from 'zod';
import { PARTNER_CATEGORIES } from '@/lib/partners/categories';
import { PARTNER_GROUP_SQL, isPartnerGroup } from '@/lib/partners/partner-groups';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  status: z.enum(['all', 'pending', 'approved', 'rejected', 'none']).default('pending'),
  // Группа по участию, а не по происхождению (lib/partners/partner-groups):
  // partners — вошли в поток заявок, potential — карточки без заявки.
  // Умолчание 'all' сохраняет прежнее поведение для прочих вызывающих.
  group:  z.enum(['all', 'partners', 'potential']).default('all'),
  limit:  z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const sp = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    status: sp.get('status') ?? 'pending',
    group:  sp.get('group')  ?? 'all',
    limit:  sp.get('limit')  ?? 50,
    offset: sp.get('offset') ?? 0,
  });
  if (!parsed.success) return NextResponse.json({ error: 'Неверные параметры' }, { status: 400 });

  const { status, group, limit, offset } = parsed.data;
  const hasStatusFilter = status !== 'all';

  // Отбор по КАТЕГОРИИ партнёрской записи, а не по роли пользователя.
  // Прежнее `u.role = 'operator'` прятало от администратора всех, кроме
  // операторов: человек с трансфером или прокатом заводился, а в очереди не
  // появлялся — заявка молча уходила в никуда. У одного человека роль одна, а
  // партнёрских записей может быть несколько.
  const cats = [...PARTNER_CATEGORIES];
  const params: (string | number | string[])[] = [cats];
  let statusClause = '';
  if (hasStatusFilter) {
    params.push(status);
    statusClause = `AND p.profile_status = $${params.length}`;
  }
  const groupClause = isPartnerGroup(group) ? `AND ${PARTNER_GROUP_SQL[group]}` : '';
  params.push(limit, offset);
  const limitIdx  = params.length - 1;
  const offsetIdx = params.length;

  const rows = await query(`
    SELECT
      p.id,
      p.name            AS company_name,
      p.contacts->>'telegram_chat_id' AS telegram_chat_id,
      -- Подключён ли канал — по тем же источникам, что читает доставка заявок
      -- (lib/partners/reach: partners.telegram_chat_id ИЛИ users.telegram_id
      -- через partners.user_id), а не по contacts JSONB.
      (p.telegram_chat_id IS NOT NULL OR u.telegram_id IS NOT NULL) AS has_telegram,
      (p.max_chat_id IS NOT NULL)      AS has_max,
      -- Есть ли у карточки аккаунт. Карточку, заведённую миграцией без
      -- пользователя (1174, «Край Вулканов»), прежний JOIN users прятал из
      -- списка целиком — и кнопка «Завести аккаунт» была бы недостижима.
      (u.id IS NOT NULL)               AS has_account,
      -- Откуда карточка: аккаунт из админки заводится только своим (NULL/'admin'),
      -- импорту с чужого сайта кнопка не показывается.
      p.external_source,
      p.category,
      p.description,
      p.profile_status,
      p.applied_at,
      p.is_verified,
      p.is_public,
      p.profile_review_comment,
      u.email,
      u.name            AS contact_name,
      u.created_at      AS registered_at,
      oa.id             AS application_id,
      oa.contact_phone,
      oa.contact_email,
      oa.inn,
      oa.status         AS application_status,
      oa.review_comment AS application_review_comment,
      oa.reviewed_at,
      p.slug,
      p.widget_enabled,
      p.widget_domains
    FROM partners p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN operator_applications oa ON oa.partner_id = p.id
    WHERE p.category = ANY($1)
      ${statusClause}
      ${groupClause}
    ORDER BY p.applied_at DESC NULLS LAST, p.created_at DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `, params);

  const countParams: (string | string[])[] = hasStatusFilter ? [cats, status] : [cats];
  const countRow = await query(`
    SELECT COUNT(*) AS total
    FROM partners p
    WHERE p.category = ANY($1)
      ${statusClause}
      ${groupClause}
  `, countParams);

  // Счётчики обеих групп — без фильтров статуса и группы: переключатель в
  // админке показывает «партнёры / потенциальные» всегда, а не только по
  // текущему срезу. Критерий — тот же фрагмент, что режет список.
  const groupCountsRow = await query(`
    SELECT
      COUNT(*) FILTER (WHERE ${PARTNER_GROUP_SQL.partners})::text  AS partners,
      COUNT(*) FILTER (WHERE ${PARTNER_GROUP_SQL.potential})::text AS potential
    FROM partners p
    WHERE p.category = ANY($1)
  `, [cats]);
  const groupCounts = {
    partners:  parseInt(String(groupCountsRow.rows[0]?.partners  ?? '0'), 10) || 0,
    potential: parseInt(String(groupCountsRow.rows[0]?.potential ?? '0'), 10) || 0,
  };

  // Последний итог личной доставки заявки (lib/leads/delivery-outcome).
  // null у оператора — записей нет; карта null — прочитать не удалось, и
  // тогда поле не отдаётся вовсе: «не знаю» не выдаётся за «записей нет».
  const ids = rows.rows.map((r) => String((r as { id: unknown }).id));
  const deliveries = await lastPartnerDeliveries(ids);
  const data = rows.rows.map((r) => {
    const id = String((r as { id: unknown }).id);
    if (deliveries === null) return r;
    return { ...r, last_delivery: deliveries.get(id) ?? null };
  });

  return NextResponse.json({
    success: true,
    data,
    meta: {
      total:  parseInt((countRow.rows[0]?.total as string) ?? '0', 10),
      limit,
      offset,
      group_counts: groupCounts,
    },
  });
}
