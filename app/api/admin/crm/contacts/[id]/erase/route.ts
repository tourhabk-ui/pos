/**
 * POST /api/admin/crm/contacts/[id]/erase — стереть карточку клиента CRM по
 * обращению человека (152-ФЗ, ст. 21; #2327).
 *
 * Исполнитель того, что обещает ответ на удаление аккаунта
 * (unprovenCrmSentence): карточку, где кроме его заявок есть чужие записи или
 * записи партнёра, удаление не стирает — по общему номеру платформа не
 * отличит его от другого клиента. Человек пишет на почту по вопросам ПД с
 * номером и почтой; администратор находит карточки на экране клиентов всех
 * партнёров, сверяет с ним и стирает здесь. До этого роута стереть карточку
 * не мог никто: экран администратора только читал, партнёр правит лишь имя,
 * заметку и метки, и обещание в ответе было исходом без исполнителя.
 *
 * Тело: { received, ticket? } — основание структурой, а не свободным текстом:
 * дата обращения (ГГГГ-ММ-ДД, не позже сегодняшней) и, если есть, его номер
 * (только цифры). Основание ложится в журнал (audit_logs) навсегда, и ПД
 * человека, попросившего их стереть, в нём остаться не должно: в свободный
 * текст администратор вписал бы имя («обращение Андрея Петрова»), а отсев
 * телефона и почты имени не ловит. Лишние поля — отказ (strict), чтобы
 * свободный текст не вернулся другим ключом. Что стирается —
 * eraseCrmContactOnRequest (lib/account/erase.ts). Кто, когда и по какому
 * обращению — audit_logs в той же транзакции: без записи в журнале стирания нет.
 *
 * Ответы: 200 — стёрто (счёт событий и задач, без ПД); 404 — нет карточки;
 * 422 — основание не годится; 503 — база не ответила, ничего не стёрто.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { eraseCrmContactOnRequest } from '@/lib/account/erase';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Дата обращения — настоящая календарная дата не позже завтрашней по UTC (запас на часовой пояс Камчатки). */
function isReceivedDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
  return d.getTime() <= Date.now() + 86_400_000;
}

const Schema = z.strictObject({
  received: z.string({ message: 'Укажите дату обращения' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата обращения — в виде ГГГГ-ММ-ДД')
    .refine(isReceivedDate, 'Дата обращения — настоящая дата, не позже сегодняшней'),
  ticket: z.string().trim()
    .regex(/^\d{0,12}$/, 'Номер обращения — только цифры, не больше 12')
    .optional()
    .transform((v) => (v ? v : null)),
}, {
  error: (iss) => (iss.code === 'unrecognized_keys'
    ? 'Основание — только дата и номер обращения, без свободного текста' : undefined),
});

export async function POST(req: NextRequest, { params }: Ctx) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }, { status: 422 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const erased = await eraseCrmContactOnRequest(client, id);
    if (!erased) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
    }
    await client.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
       VALUES ($1, 'crm_contact_erased_on_request', 'crm_contact', $2, $3::jsonb)`,
      [admin.userId, id, JSON.stringify({
        received: parsed.data.received, ticket: parsed.data.ticket, partner_id: erased.partnerId,
      })],
    );
    await client.query('COMMIT');
    return NextResponse.json({ success: true, data: { events: erased.events, tasks: erased.tasks } });
  } catch (err) {
    await client.query('ROLLBACK').catch((e) => logSwallowedFailure('admin/crm/erase', 'ROLLBACK', e));
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[admin/crm/erase] карточка не стёрта, SQLSTATE', code);
    return NextResponse.json({ success: false, error: 'Не удалось стереть карточку, попробуйте позже' }, { status: 503 });
  } finally {
    client.release();
  }
}
