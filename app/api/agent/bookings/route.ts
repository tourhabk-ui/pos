/**
 * GET  /api/agent/bookings — продажи агента: брони по его ссылке и брони,
 *                            оформленные им за клиента.
 * POST /api/agent/bookings — оформить бронь за своего клиента.
 *
 * ── Что было до 26.09 ─────────────────────────────────────────────────────
 *
 * POST писал в `agent_bookings` — отдельную таблицу, которую оператор не
 * видит вовсе. Заявка агента существовала только в его кабинете: ни
 * календаря оператора, ни счёта мест, ни транзакции, промокод «списывался»
 * до вставки, а строка комиссии 10% писалась в момент создания — деньги
 * агенту считались с брони, которую никто не подтверждал и никто не оплатил.
 * `clientId` не сверялся с агентом: можно было оформить бронь на чужого
 * клиента.
 *
 * ── Как теперь (решение владельца 26.09) ──────────────────────────────────
 *
 * Бронь за клиента — ОБЫЧНАЯ бронь оператора: `reserveBooking` (календарь,
 * места, одна транзакция), `created_via = 'agent'`, `agent_user_id` = агент.
 * Имя, телефон и почта туриста берутся из карточки клиента, которая обязана
 * принадлежать этому агенту. В ответе — ссылка для туриста
 * (`/booking-success/{id}?t=...`): оператор подтвердит бронь, после этого
 * клиент оплатит по ней сам. Строки комиссии здесь нет — вознаграждение
 * считается по ОПЛАЧЕННЫМ броням (пакет «деньги агента»), а ставку назначает
 * владелец.
 *
 * `agent_bookings` больше не пишется. Таблица не удаляется: на проде в ней
 * могут лежать старые строки (и на неё ссылается `agent_commissions`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAgent } from '@/lib/auth/middleware';
import { requireApprovedAgent } from '@/lib/auth/agent-approval';
import { reserveBooking, ReserveError } from '@/lib/bookings/reserve';
import { canOfferPayment } from '@/lib/bookings/success-view';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { reachForPartner } from '@/lib/partners/reach';
import { notifyNewBooking } from '@/lib/notifications/operator-booking';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

/** Метка канала брони за клиента — пишется в operator_bookings.created_via. */
const AGENT_BOOKING_VIA = 'agent';

const CreateAgentBookingSchema = z.object({
  clientId:        z.string().uuid('Выберите клиента'),
  tourId:          z.coerce.number().int().positive('Выберите тур'),
  tourDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Выберите дату тура'),
  guestsCount:     z.coerce.number().int().min(1, 'Минимум 1 участник').max(100, 'Не больше 100 участников'),
  specialRequests: z.string().trim().max(2000, 'Пожелания — не длиннее 2000 символов').optional(),
});

const ListQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  limit:    z.coerce.number().int().min(1).max(200).default(100),
});

function sqlstateOf(err: unknown): string {
  return (err as { code?: string }).code ?? 'нет SQLSTATE';
}

function touristLink(bookingId: number | string, token: string): string {
  return `${getPublicBaseUrl()}/booking-success/${bookingId}?t=${encodeURIComponent(token)}`;
}

interface SaleRow {
  id: string;
  booking_date: string;
  end_date: string | null;
  participants: number;
  final_price: string | null;
  booking_status: string;
  payment_status: string | null;
  is_paid: boolean;
  created_via: string | null;
  created_at: string;
  tour_title: string;
  client_id: string | null;
  client_name: string | null;
  access_token: string | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const parsed = ListQuerySchema.safeParse({
    clientId: sp.get('clientId') ?? undefined,
    limit:    sp.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры запроса' }, { status: 400 });
  }
  const { clientId, limit } = parsed.data;

  const params: unknown[] = [auth.userId, AGENT_BOOKING_VIA, limit];
  let clientFilter = '';
  if (clientId) {
    params.push(clientId);
    clientFilter = `AND ob.metadata->>'agent_client_id' = $${params.length}`;
  }

  try {
    // Только СВОИ продажи: agent_user_id = этот агент. Имя туриста агенту
    // показывается лишь у брони за его клиента (оно из его же карточки);
    // у брони по ссылке турист агенту не клиент, и его ПД сюда не идут.
    // Ссылка туриста (access_token) — тоже только у брони за клиента:
    // бронь по ссылке турист оформил сам, и ключ от неё — его.
    const { rows } = await pool.query<SaleRow>(
      `SELECT ob.id::text                    AS id,
              ob.booking_date::text          AS booking_date,
              ob.end_date::text              AS end_date,
              ob.participants,
              ob.final_price::text           AS final_price,
              ob.booking_status,
              ob.payment_status,
              (ob.paid_at IS NOT NULL)       AS is_paid,
              ob.created_via,
              ob.created_at::text            AS created_at,
              ot.title                       AS tour_title,
              ac.id::text                    AS client_id,
              ac.name                        AS client_name,
              CASE WHEN ob.created_via = $2 THEN ob.access_token::text END AS access_token
         FROM operator_bookings ob
         JOIN operator_tours ot ON ot.id = ob.operator_tour_id
         LEFT JOIN agent_clients ac
                ON ob.created_via = $2
               AND ac.id::text = ob.metadata->>'agent_client_id'
               AND ac.agent_id = ob.agent_user_id
        WHERE ob.agent_user_id = $1
          AND ob.deleted_at IS NULL
          ${clientFilter}
        ORDER BY ob.created_at DESC
        LIMIT $3`,
      params,
    );

    const bookings = rows.map(r => {
      const viaClient = r.created_via === AGENT_BOOKING_VIA;
      return {
        id:            r.id,
        path:          viaClient ? 'client' as const : 'link' as const,
        tourTitle:     r.tour_title,
        tourDate:      r.booking_date,
        endDate:       r.end_date,
        participants:  r.participants,
        totalPrice:    r.final_price == null ? null : Number(r.final_price),
        status:        r.booking_status,
        paymentStatus: r.payment_status,
        paid:          r.is_paid,
        // Оплатить можно только подтверждённую оператором бронь (§7).
        awaitingPayment: !r.is_paid && canOfferPayment(r.booking_status),
        clientId:      viaClient ? r.client_id : null,
        clientName:    viaClient ? r.client_name : null,
        touristLink:   viaClient && r.access_token ? touristLink(r.id, r.access_token) : null,
        createdAt:     r.created_at,
      };
    });

    return NextResponse.json({ success: true, data: { bookings, total: bookings.length } });
  } catch (err) {
    console.error(`[agent/bookings] продажи агента не прочитаны, SQLSTATE ${sqlstateOf(err)}:`,
      err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить брони. Попробуйте позже.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireApprovedAgent(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = CreateAgentBookingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const { clientId, tourId, tourDate, guestsCount, specialRequests } = parsed.data;

  if (tourDate < new Date().toISOString().slice(0, 10)) {
    return NextResponse.json(
      { success: false, error: 'Выбранная дата уже прошла. Укажите будущую дату.' },
      { status: 422 },
    );
  }

  // Клиент обязан быть СВОИМ: agent_clients.agent_id = users.id агента.
  let client: { name: string; phone: string | null; email: string | null } | undefined;
  try {
    const { rows } = await pool.query<{ name: string; phone: string | null; email: string | null }>(
      `SELECT name, phone, email FROM agent_clients WHERE id = $1 AND agent_id = $2`,
      [clientId, auth.userId],
    );
    client = rows[0];
  } catch (err) {
    console.error(`[agent/bookings] клиент агента не прочитан, SQLSTATE ${sqlstateOf(err)}:`,
      err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось проверить клиента. Попробуйте позже.' },
      { status: 500 },
    );
  }
  if (!client) {
    return NextResponse.json({ success: false, error: 'Клиент не найден среди ваших клиентов' }, { status: 404 });
  }

  // Оператору нужно, чем связаться с туристом: без телефона бронь не
  // заводится, а не заводится «с пустым номером».
  const phone = client.phone ? normalizePhone(client.phone) : null;
  if (!phone) {
    return NextResponse.json(
      { success: false, error: 'У клиента нет корректного телефона — добавьте его в карточке клиента' },
      { status: 422 },
    );
  }

  try {
    const result = await reserveBooking({
      tourId,
      touristName:     client.name,
      touristPhone:    phone,
      touristEmail:    client.email,
      participants:    guestsCount,
      date:            tourDate,
      specialRequests: specialRequests ?? '',
      createdVia:      AGENT_BOOKING_VIA,
      // Аккаунта у туриста здесь нет, и аккаунт агента ему НЕ приписывается:
      // иначе бронь клиента легла бы в личный кабинет агента как его поездка.
      userId:          null,
      agentUserId:     auth.userId,
      metadata:        { agent_client_id: clientId },
      // Согласие на ПД агент за клиента дать не может — NULL, «не спрашивали».
      pdConsent:       null,
    });

    // Уведомление оператору — как у формы на карточке тура. Не валит бронь,
    // но и не глушится (§4.0).
    void (async () => {
      try {
        const [opRow, reach] = await Promise.all([
          pool.query<{ name: string; phone: string | null; email: string | null }>(
            `SELECT name, contacts->>'phone' AS phone, contacts->>'email' AS email
               FROM partners WHERE id = $1 LIMIT 1`,
            [result.operatorId],
          ),
          reachForPartner(result.operatorId),
        ]);
        const op = opRow.rows[0];
        await notifyNewBooking({
          booking_id:                String(result.bookingId),
          tour_title:                result.tourTitle,
          tourist_name:              client.name,
          tourist_phone:             phone,
          tourist_email:             client.email ?? undefined,
          booking_date:              tourDate,
          participants:              guestsCount,
          final_price:               result.totalPrice,
          operator_name:             op?.name ?? 'Оператор',
          operator_telegram_chat_id: reach?.telegramChatId ?? undefined,
          operator_max_chat_id:      reach?.maxChatId ?? undefined,
          operator_phone:            op?.phone ?? null,
          operator_email:            op?.email ?? null,
          via:                       AGENT_BOOKING_VIA,
        });
      } catch (err) {
        console.error(
          `[agent/bookings] уведомление оператору не отправлено, бронь ${String(result.bookingId)}, SQLSTATE ${sqlstateOf(err)}:`,
          err instanceof Error ? err.message : err,
        );
      }
    })();

    return NextResponse.json({
      success: true,
      data: {
        bookingId:   result.bookingId,
        totalPrice:  result.totalPrice,
        touristLink: touristLink(result.bookingId, result.accessToken),
      },
      message: 'Заявка отправлена оператору. Оператор подтвердит бронь, после этого клиент оплатит по ссылке.',
    });
  } catch (err) {
    if (err instanceof ReserveError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.code === 'NOT_FOUND' ? 404 : 422 },
      );
    }
    console.error(`[agent/bookings] бронь за клиента не заведена, тур ${tourId}, SQLSTATE ${sqlstateOf(err)}:`,
      err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось создать бронь. Попробуйте позже.' },
      { status: 500 },
    );
  }
}
