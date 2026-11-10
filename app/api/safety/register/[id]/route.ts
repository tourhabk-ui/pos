import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { generateMchsStatementPDF, statementMembers } from '@/lib/pdf/mchs-statement';
import { requireAuth } from '@/lib/auth/middleware';
import { canReadRegistration } from '@/lib/safety/registration-read';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Строка базы → данные листа. Лист один на форму и на выдачу по номеру (lib/pdf/mchs-statement). */
function statementFromRow(reg: Record<string, unknown>) {
  const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const day = (v: unknown): string | Date => (v instanceof Date ? v : text(v));
  return {
    id: text(reg.id),
    routeName: text(reg.route_name),
    routeDescription: text(reg.route_description) || null,
    region: text(reg.region) || 'Камчатский край',
    startDate: day(reg.start_date),
    endDate: day(reg.end_date),
    leaderName: text(reg.leader_name),
    leaderPhone: text(reg.leader_phone),
    leaderEmail: text(reg.leader_email) || null,
    groupSize: text(reg.group_size),
    members: statementMembers(reg.group_members),
    contactName: text(reg.emergency_contact_name),
    contactPhone: text(reg.emergency_contact_phone),
    contactRelation: text(reg.emergency_contact_relation) || null,
  };
}

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ success: false, error: 'Некорректный идентификатор регистрации' }, { status: 400 });
  }

  // Проверка безопасности 29.09 (#2073): здесь не было проверки ни входа, ни
  // владельца — любой залогиненный с чужим UUID получал ФИО и телефоны
  // группы, год рождения участников и экстренный контакт. UUID утекает
  // легко (ссылка на PDF, пересланный экран), а ПД группы — не публичные.
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const result = await query(
    `SELECT id, user_id, route_name, route_description, start_date, end_date, region,
            group_size, group_members, leader_name, leader_phone, leader_email,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
            completed_at, mchs_status, created_at
     FROM route_registrations WHERE id = $1`,
    [id],
  );

  // Чужая регистрация отвечает тем же 404, что и несуществующая: иначе
  // ответ подтверждал бы, что такой UUID есть.
  const row = result.rows[0] as (Record<string, unknown> & { user_id?: string | null }) | undefined;
  if (!row || !canReadRegistration({ userId: auth.userId, role: auth.role }, row.user_id ?? null)) {
    return NextResponse.json({ success: false, error: 'Регистрация не найдена' }, { status: 404 });
  }

  const { user_id: _owner, ...reg } = row;
  void _owner;
  const wantPdf = request.nextUrl.searchParams.has('pdf');

  if (wantPdf) {
    const pdfBuffer = await generateMchsStatementPDF(statementFromRow(reg));
    // Uint8Array: с TS 5.9 Buffer не проходит в BodyInit без каста.
    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="vedar-mchs-dannye-${String(reg.id).slice(0, 8)}.pdf"`,
      },
    });
  }

  return NextResponse.json({ success: true, registration: reg });
}
