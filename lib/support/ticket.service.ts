/**
 * Support Ticket Service
 *
 * CRUD + lifecycle для тикетов поддержки.
 * Тикет создаётся из Telegram-бота или веб-интерфейса,
 * живёт до resolution, эскалируется если завис.
 */

import { query } from '@/lib/database';
import { categorizeSupport, type SupportCategory } from './categorize';
import { notifyAdminNewTicket } from '@/lib/telegram/admin-notify';

export interface SupportMessage {
  role: 'user' | 'agent' | 'system';
  text: string;
  ts: string;
}

export interface SupportTicket {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  channel: string;
  category: SupportCategory;
  subject: string;
  status: string;
  assignedAgent: string | null;
  messages: SupportMessage[];
  resolution: string | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TicketRow {
  id: string;
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  channel: string;
  category: SupportCategory;
  subject: string;
  status: string;
  assigned_agent: string | null;
  messages: SupportMessage[];
  resolution: string | null;
  escalated_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeRow(row: TicketRow): SupportTicket {
  return {
    id:           row.id,
    userId:       row.user_id,
    userName:     row.user_name ?? null,
    userEmail:    row.user_email ?? null,
    channel:      row.channel,
    category:     row.category,
    subject:      row.subject,
    status:       row.status,
    assignedAgent:row.assigned_agent,
    messages:     row.messages ?? [],
    resolution:   row.resolution,
    escalatedAt:  row.escalated_at,
    resolvedAt:   row.resolved_at,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

/**
 * Создаёт новый тикет и назначает Резидента по категории.
 */
export async function createTicket(input: {
  userId: string;
  channel?: string;
  subject: string;
  firstMessage: string;
  /** Категория, выбранная человеком в форме; без неё — по тексту. */
  category?: SupportCategory;
  /** Имя и почта из веб-формы (миграция 698); из Telegram их нет. */
  userName?: string | null;
  userEmail?: string | null;
}): Promise<SupportTicket> {
  const auto = categorizeSupport(input.subject + ' ' + input.firstMessage);
  const category = input.category ?? auto.category;
  const resident = auto.resident;

  const firstMsg: SupportMessage = {
    role: 'user',
    text: input.firstMessage,
    ts:   new Date().toISOString(),
  };

  const res = await query<TicketRow>(
    `INSERT INTO support_tickets
       (user_id, channel, category, subject, status, assigned_agent, messages, user_name, user_email)
     VALUES ($1, $2, $3, $4, 'assigned', $5, $6::jsonb, $7, $8)
     RETURNING *`,
    [
      input.userId,
      input.channel ?? 'telegram',
      category,
      input.subject,
      resident,
      JSON.stringify([firstMsg]),
      input.userName ?? null,
      input.userEmail ?? null,
    ]
  );

  const ticket = normalizeRow(res.rows[0]);
  notifyAdminNewTicket(ticket);
  return ticket;
}

/**
 * Добавляет сообщение в тикет.
 */
export async function addTicketMessage(
  ticketId: string,
  message: Omit<SupportMessage, 'ts'>
): Promise<void> {
  const msg: SupportMessage = { ...message, ts: new Date().toISOString() };
  await query(
    `UPDATE support_tickets
     SET messages   = messages || $1::jsonb,
         updated_at = NOW(),
         status     = CASE WHEN status = 'assigned' THEN 'in_progress' ELSE status END
     WHERE id = $2`,
    [JSON.stringify([msg]), ticketId]
  );
}

/**
 * Закрывает тикет с решением.
 */
export async function resolveTicket(ticketId: string, resolution: string): Promise<void> {
  await query(
    `UPDATE support_tickets
     SET status      = 'resolved',
         resolution  = $1,
         resolved_at = NOW(),
         updated_at  = NOW()
     WHERE id = $2`,
    [resolution, ticketId]
  );
}

/**
 * Эскалирует тикет на Совет директоров.
 */
export async function escalateTicket(ticketId: string, reason: string): Promise<void> {
  const escalateMsg: SupportMessage = {
    role: 'system',
    text: `Эскалация: ${reason}`,
    ts:   new Date().toISOString(),
  };
  await query(
    `UPDATE support_tickets
     SET status       = 'escalated',
         escalated_at = NOW(),
         messages     = messages || $1::jsonb,
         updated_at   = NOW()
     WHERE id = $2`,
    [JSON.stringify([escalateMsg]), ticketId]
  );
}

/**
 * Открытые тикеты пользователя.
 */
export async function getUserOpenTickets(userId: string): Promise<SupportTicket[]> {
  const res = await query<TicketRow>(
    `SELECT id, user_id, user_name, user_email, channel, category, subject, status, assigned_agent, messages, resolution, escalated_at, resolved_at, created_at, updated_at FROM support_tickets
     WHERE user_id = $1 AND status NOT IN ('resolved', 'closed')
     ORDER BY created_at DESC LIMIT 5`,
    [userId]
  );
  return res.rows.map(normalizeRow);
}

/**
 * Тикеты требующие эскалации (висят более 24ч без ответа агента).
 */
export async function getOverdueTickets(): Promise<SupportTicket[]> {
  const res = await query<TicketRow>(
    `SELECT id, user_id, user_name, user_email, channel, category, subject, status, assigned_agent, messages, resolution, escalated_at, resolved_at, created_at, updated_at FROM support_tickets
     WHERE status IN ('open', 'assigned')
       AND updated_at < NOW() - INTERVAL '24 hours'
     ORDER BY created_at ASC LIMIT 20`
  );
  return res.rows.map(normalizeRow);
}

/**
 * Один тикет по id — для агента и админки. null — нет такого.
 */
export async function getTicketById(ticketId: string): Promise<SupportTicket | null> {
  const res = await query<TicketRow>(
    `SELECT st.*, u.name AS user_name, u.email AS user_email
     FROM support_tickets st
     LEFT JOIN users u ON u.id = st.user_id
     WHERE st.id = $1 LIMIT 1`,
    [ticketId]
  );
  return res.rows[0] ? normalizeRow(res.rows[0]) : null;
}

/**
 * Тикет, если он принадлежит этому пользователю. Чужой тикет и
 * несуществующий отвечают одинаково — null: по ответу нельзя перебрать
 * чужие id.
 */
export async function getTicketForUser(ticketId: string, userId: string): Promise<SupportTicket | null> {
  const res = await query<TicketRow>(
    `SELECT id, user_id, user_name, user_email, channel, category, subject, status, assigned_agent, messages, resolution, escalated_at, resolved_at, created_at, updated_at
     FROM support_tickets
     WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [ticketId, userId]
  );
  return res.rows[0] ? normalizeRow(res.rows[0]) : null;
}

/**
 * Все тикеты пользователя (экран поддержки в кабинете туриста, 04.09).
 * В отличие от getUserOpenTickets — со всеми статусами: человек должен
 * видеть и решённые, иначе «решили» неотличимо от «потеряли».
 */
export async function listUserTickets(
  userId: string,
  filter?: { status?: string; limit?: number },
): Promise<SupportTicket[]> {
  const params: unknown[] = [userId];
  let where = 'WHERE user_id = $1';
  if (filter?.status) {
    params.push(filter.status);
    where += ` AND status = $${params.length}`;
  }
  params.push(Math.min(Math.max(filter?.limit ?? 50, 1), 200));
  const res = await query<TicketRow>(
    `SELECT id, user_id, user_name, user_email, channel, category, subject, status, assigned_agent, messages, resolution, escalated_at, resolved_at, created_at, updated_at
     FROM support_tickets
     ${where}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return res.rows.map(normalizeRow);
}

/** Статусы и категории — ровно те, что разрешает CHECK миграции 078. */
export const TICKET_STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'escalated', 'closed'] as const;
export const TICKET_CATEGORIES = ['billing', 'booking', 'safety', 'content', 'technical', 'refund', 'operator', 'other'] as const;

/**
 * Правка агентом: статус, категория, назначенный Резидент. Только
 * объявленные колонки; поля «priority», «tags» у тикета нет — и их нет здесь.
 */
export async function updateTicket(
  ticketId: string,
  patch: { status?: string; category?: string; assignedAgent?: string | null },
): Promise<SupportTicket | null> {
  const res = await query<TicketRow>(
    `UPDATE support_tickets
     SET status         = COALESCE($2, status),
         category       = COALESCE($3, category),
         assigned_agent = COALESCE($4, assigned_agent),
         resolved_at    = CASE WHEN $2 = 'resolved' AND resolved_at IS NULL THEN NOW() ELSE resolved_at END,
         updated_at     = NOW()
     WHERE id = $1
     RETURNING *`,
    [ticketId, patch.status ?? null, patch.category ?? null, patch.assignedAgent ?? null]
  );
  return res.rows[0] ? normalizeRow(res.rows[0]) : null;
}

/**
 * Все тикеты (для admin).
 */
export async function listTickets(filter?: { status?: string; category?: string }): Promise<SupportTicket[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    params.push(filter.status);
    conditions.push(`st.status = $${params.length}`);
  }
  if (filter?.category) {
    params.push(filter.category);
    conditions.push(`st.category = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await query<TicketRow>(
    `SELECT st.*, u.name AS user_name, u.email AS user_email
     FROM support_tickets st
     LEFT JOIN users u ON u.id = st.user_id
     ${where} ORDER BY st.created_at DESC LIMIT 50`,
    params
  );
  return res.rows.map(normalizeRow);
}
