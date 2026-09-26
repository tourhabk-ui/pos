/**
 * GET  /api/agent/clients — клиенты агента.
 * POST /api/agent/clients — завести клиента (нужен для брони за клиента).
 *
 * Правки 26.09 (пакет A кабинета агента):
 *   - POST падал на NOT NULL: `status` был необязательным в схеме и
 *     вставлялся явным NULL поверх умолчания колонки. Теперь умолчание
 *     'prospect' — то же, что у колонки.
 *   - Почта стала необязательной, телефон — обязательным: клиенту агента
 *     бронь заводится по телефону (оператору нужно, чем связаться), а почты
 *     у человека может не быть.
 *   - `JSON.parse` на jsonb-колонке `tags` ронял GET: pg уже отдаёт массив.
 *   - Счётчики броней и сумма оплаченного считаются из operator_bookings
 *     (брони агента за этого клиента), а не из кэш-колонок, которые писала
 *     только удалённая запись в agent_bookings.
 *   - Писать могут только одобренные агенты (requireApprovedAgent).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAgent } from '@/lib/auth/middleware';
import { requireApprovedAgent } from '@/lib/auth/agent-approval';
import {
  CLIENT_STATUSES, ClientFieldsSchema, CLIENT_PHONE_MESSAGE,
  clientPhone, readTags, sqlstateOf,
} from '@/lib/agent-cabinet/client-fields';

export const dynamic = 'force-dynamic';

const ListQuerySchema = z.object({
  status: z.enum(['all', ...CLIENT_STATUSES]).default('all'),
  search: z.string().trim().max(100).default(''),
  limit:  z.coerce.number().int().min(1).max(200).default(50),
});

interface ClientRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: string;
  notes: string | null;
  tags: unknown;
  source: string | null;
  created_at: string;
  updated_at: string;
  bookings: number;
  paid_total: string;
  last_booking: string | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const parsed = ListQuerySchema.safeParse({
    status: sp.get('status') ?? undefined,
    search: sp.get('search') ?? undefined,
    limit:  sp.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры запроса' }, { status: 400 });
  }
  const { status, search, limit } = parsed.data;

  const params: unknown[] = [auth.userId];
  let where = 'WHERE c.agent_id = $1';
  if (status !== 'all') {
    params.push(status);
    where += ` AND c.status = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    where += ` AND (c.name ILIKE $${n} OR c.email ILIKE $${n} OR c.phone ILIKE $${n} OR c.company ILIKE $${n})`;
  }
  params.push(limit);

  try {
    const { rows } = await pool.query<ClientRow>(
      `SELECT c.id::text AS id, c.name, c.email, c.phone, c.company, c.status,
              c.notes, c.tags, c.source,
              c.created_at::text AS created_at, c.updated_at::text AS updated_at,
              COALESCE(b.bookings, 0)::int     AS bookings,
              COALESCE(b.paid_total, 0)::text  AS paid_total,
              b.last_booking::text             AS last_booking
         FROM agent_clients c
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE ob.booking_status NOT IN ('cancelled', 'rejected')) AS bookings,
                  SUM(ob.final_price) FILTER (WHERE ob.paid_at IS NOT NULL)                  AS paid_total,
                  MAX(ob.created_at)                                                           AS last_booking
             FROM operator_bookings ob
            WHERE ob.agent_user_id = c.agent_id
              AND ob.created_via = 'agent'
              AND ob.metadata->>'agent_client_id' = c.id::text
              AND ob.deleted_at IS NULL
         ) b ON true
         ${where}
        ORDER BY c.created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    const clients = rows.map(r => ({
      id:            r.id,
      name:          r.name,
      email:         r.email ?? undefined,
      phone:         r.phone ?? undefined,
      company:       r.company ?? undefined,
      status:        r.status,
      notes:         r.notes ?? undefined,
      // jsonb уже приходит массивом; строку или мусор не парсим и не роняем.
      tags:          readTags(r.tags),
      source:        r.source ?? 'direct',
      totalBookings: r.bookings,
      totalSpent:    Number(r.paid_total),
      lastBooking:   r.last_booking,
      createdAt:     r.created_at,
      updatedAt:     r.updated_at,
    }));

    return NextResponse.json({ success: true, data: { clients, total: clients.length } });
  } catch (err) {
    console.error(`[agent/clients] список клиентов не прочитан, SQLSTATE ${sqlstateOf(err)}:`,
      err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить клиентов. Попробуйте позже.' },
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
  const parsed = ClientFieldsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const f = parsed.data;
  const phone = clientPhone(f.phone);
  if (!phone) {
    return NextResponse.json(
      { success: false, error: CLIENT_PHONE_MESSAGE },
      { status: 400 },
    );
  }
  const email = f.email ? f.email : null;

  try {
    // Дубль — по телефону (он обязателен) или по почте, если она есть.
    const dup = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM agent_clients
        WHERE agent_id = $1 AND (phone = $2 OR ($3::text IS NOT NULL AND email = $3::text))
        LIMIT 1`,
      [auth.userId, phone, email],
    );
    if (dup.rows.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Клиент с таким телефоном или email уже есть' },
        { status: 409 },
      );
    }

    const { rows } = await pool.query<{ id: string; created_at: string }>(
      `INSERT INTO agent_clients (agent_id, name, email, phone, company, status, notes, tags, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING id::text AS id, created_at::text AS created_at`,
      [auth.userId, f.name, email, phone, f.company || null, f.status, f.notes || null,
        JSON.stringify(f.tags), f.source],
    );

    return NextResponse.json(
      { success: true, data: { clientId: rows[0]!.id, createdAt: rows[0]!.created_at }, message: 'Клиент добавлен' },
      { status: 201 },
    );
  } catch (err) {
    console.error(`[agent/clients] клиент не создан, SQLSTATE ${sqlstateOf(err)}:`,
      err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить клиента. Попробуйте позже.' },
      { status: 500 },
    );
  }
}
