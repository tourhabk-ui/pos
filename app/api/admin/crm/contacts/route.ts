/**
 * GET /api/admin/crm/contacts?q=&tag=&category=&partner=&page= — клиенты всех
 * партнёров для администратора (CRM #2325, решение владельца 09.10).
 *
 * Только чтение: обработчиков записи у роута нет — метки и заметки клиента
 * правит его партнёр, а не администратор. Edge пускает на /api/admin только
 * с admin-JWT; requireAdmin здесь — вторая проверка, а не единственная.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { PARTNER_ROLES } from '@/lib/auth/role-routes';
import { listAllContacts } from '@/lib/crm/admin-queries';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

const ListQuery = z.object({
  q: z.string().max(100).optional(),
  tag: z.string().max(40).optional(),
  category: z.enum(PARTNER_ROLES).optional(),
  partner: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const sp = req.nextUrl.searchParams;
  const parsed = ListQuery.safeParse({
    q: sp.get('q') ?? undefined,
    tag: sp.get('tag') ?? undefined,
    category: sp.get('category') ?? undefined,
    partner: sp.get('partner') ?? undefined,
    page: sp.get('page') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры поиска' }, { status: 400 });
  }
  const { q, tag, category, partner, page } = parsed.data;

  try {
    const { items, total, facets } = await listAllContacts({
      q, tag, category, partnerId: partner, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
    });
    return NextResponse.json({ success: true, data: { items, total, page, pageSize: PAGE_SIZE, facets } });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm/admin] список клиентов не прочитан, SQLSTATE', code);
    return NextResponse.json({ success: false, error: 'Не удалось загрузить клиентов, попробуйте позже' }, { status: 503 });
  }
}
