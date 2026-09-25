import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';

export const dynamic = 'force-dynamic';

// -- Zod-схемы для валидации входных данных --

const groupMemberSchema = z.object({
  fullName: z.string().min(2).max(150),
  phone: z.string().max(30).optional(),
  birthDate: z.string().max(30).optional(),
});

const guideContactSchema = z.object({
  name: z.string().min(2).max(150),
  phone: z.string().min(5).max(30),
});

const emergencyContactSchema = z.object({
  name: z.string().min(2).max(150),
  phone: z.string().min(5).max(30),
  relation: z.string().max(100).optional(),
});

const createRegistrationSchema = z.object({
  // Номер брони оператора — operator_bookings.id, BIGINT. Раньше здесь стоял
  // .uuid(): форма просила «UUID бронирования», которого у брони оператора
  // нет, а сверка uuid-строки с bigint-колонкой падала 22P02 — запись не
  // создавалась никогда (миграция 1016). Принимаем число или его строку.
  bookingId: z.coerce
    .number({ message: 'Номер брони должен быть числом' })
    .int({ message: 'Номер брони должен быть целым числом' })
    .positive({ message: 'Номер брони должен быть положительным числом' }),
  groupComposition: z.array(groupMemberSchema).min(1).max(100),
  route: z.string().min(3).max(5000),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  guideContacts: guideContactSchema,
  emergencyContacts: z.array(emergencyContactSchema).min(1).max(20),
}).superRefine((data, ctx) => {
  const start = new Date(data.startDate);
  const end = new Date(data.endDate);

  if (Number.isNaN(start.getTime())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startDate'],
      message: 'Неверный формат даты начала',
    });
  }

  if (Number.isNaN(end.getTime())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'Неверный формат даты окончания',
    });
  }

  if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start > end) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'Дата окончания не может быть раньше даты начала',
    });
  }
});

// -- Типы для строк из БД --

type MchsStatus = 'pending' | 'submitted' | 'confirmed' | 'rejected';

interface MchsRegistrationListRow {
  id: string;
  /** operator_bookings.id (bigint приходит из pg строкой); NULL у старых записей по bookings. */
  operator_booking_id: string | null;
  route: string;
  start_date: string;
  end_date: string;
  status: MchsStatus;
  mchs_reference: string | null;
  created_at: string;
  updated_at: string;
}

interface MchsSummaryRow {
  total: string;
  pending: string;
  submitted: string;
  confirmed: string;
  rejected: string;
}

/** §4.0: отказ не глушится — имя шага и SQLSTATE в лог, текст PostgreSQL наружу не уходит. */
function logMchsFailure(step: string, error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[operator/mchs/register] ${step}: отказ${typeof code === 'string' ? ` SQLSTATE ${code}` : ''} — ${message}`,
  );
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * GET /api/operator/mchs/register
 * Получение списка регистраций МЧС для текущего оператора
 */
export async function GET(request: NextRequest) {
  try {
    const userOrResponse = await requireOperator(request);
    if (userOrResponse instanceof NextResponse) {
      return userOrResponse;
    }

    // operator_id из JWT-сессии, привязка через partners
    const operatorId = await getOperatorPartnerId(userOrResponse.userId);
    if (!operatorId) {
      return NextResponse.json(
        { success: false, error: 'Партнёрский профиль оператора не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const { searchParams } = new URL(request.url);
    const queryValidation = listQuerySchema.safeParse({
      limit: searchParams.get('limit') ?? undefined,
    });

    if (!queryValidation.success) {
      return NextResponse.json(
        { success: false, error: queryValidation.error.issues } as unknown as ApiResponse<null>,
        { status: 400 }
      );
    }

    const { limit } = queryValidation.data;

    // Фильтрация только по operator_id текущего пользователя
    const listResult = await query<MchsRegistrationListRow>(
      `SELECT
         id,
         operator_booking_id::text AS operator_booking_id,
         route,
         start_date,
         end_date,
         status,
         mchs_reference,
         created_at,
         updated_at
       FROM mchs_registrations
       WHERE operator_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [operatorId, limit]
    );

    // Сводка по статусам для dashboard-виджета
    const summaryResult = await query<MchsSummaryRow>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'submitted')::text AS submitted,
         COUNT(*) FILTER (WHERE status = 'confirmed')::text AS confirmed,
         COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected
       FROM mchs_registrations
       WHERE operator_id = $1`,
      [operatorId]
    );

    const summary = summaryResult.rows[0] ?? {
      total: '0',
      pending: '0',
      submitted: '0',
      confirmed: '0',
      rejected: '0',
    };

    return NextResponse.json({
      success: true,
      data: {
        registrations: listResult.rows.map(row => ({
          id: row.id,
          bookingId: row.operator_booking_id,
          route: row.route,
          startDate: row.start_date,
          endDate: row.end_date,
          status: row.status,
          mchsReference: row.mchs_reference,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        summary: {
          total: Number.parseInt(summary.total, 10) || 0,
          pending: Number.parseInt(summary.pending, 10) || 0,
          submitted: Number.parseInt(summary.submitted, 10) || 0,
          confirmed: Number.parseInt(summary.confirmed, 10) || 0,
          rejected: Number.parseInt(summary.rejected, 10) || 0,
        },
      },
    } as ApiResponse<unknown>);
  } catch (error) {
    logMchsFailure('GET', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить регистрации МЧС' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

/**
 * POST /api/operator/mchs/register
 * Создание новой регистрации группы в МЧС
 * operator_id берётся из JWT-сессии, никогда из тела запроса
 */
export async function POST(request: NextRequest) {
  try {
    const userOrResponse = await requireOperator(request);
    if (userOrResponse instanceof NextResponse) {
      return userOrResponse;
    }

    // operator_id из JWT-сессии через partners
    const operatorId = await getOperatorPartnerId(userOrResponse.userId);
    if (!operatorId) {
      return NextResponse.json(
        { success: false, error: 'Партнёрский профиль оператора не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const payload: unknown = await request.json();
    const validation = createRegistrationSchema.safeParse(payload);

    if (!validation.success) {
      // Текстом, а не массивом issues: форма показывает строку, и «Не удалось»
      // вместо причины оставляло оператора гадать, что не так (аудит).
      const first = validation.error.issues[0];
      const field = first?.path.join('.') ?? '';
      return NextResponse.json(
        {
          success: false,
          error: `Проверьте поле${field ? ` «${field}»` : ''}: ${first?.message ?? 'некорректные данные'}`,
          details: validation.error.issues,
        } as unknown as ApiResponse<null>,
        { status: 400 }
      );
    }

    const data = validation.data;

    // Проверка владения бронированием: operator_bookings -> operator_tours ->
    // partners, где partners.user_id — текущий пользователь, а категория —
    // оператор. operatorId уже получен тем же условием (getOperatorPartnerId),
    // JOIN на partners держит связку явно в самом запросе.
    const ownershipResult = await query<{ id: string }>(
      `SELECT b.id::text AS id
       FROM operator_bookings b
       JOIN operator_tours t ON t.id = b.operator_tour_id
       JOIN partners p ON p.id = t.operator_id
       WHERE b.id = $1::bigint
         AND t.operator_id = $2
         AND p.user_id = $3
         AND p.category = 'operator'
         AND b.deleted_at IS NULL AND t.deleted_at IS NULL
       LIMIT 1`,
      [data.bookingId, operatorId, userOrResponse.userId]
    );

    if (ownershipResult.rows.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Бронь №${data.bookingId} не найдена среди броней ваших туров`,
        } as ApiResponse<null>,
        { status: 404 }
      );
    }

    // Начальный статус — pending. Это ТОЛЬКО внутренняя запись кабинета
    // оператора (§10 CLAUDE.md, раздел явно назван «заготовкой») — сюда
    // не подключена ни одна интеграция с реальным API МЧС, и вызывать
    // отсюда нечего. Настоящая регистрация группы делается оператором
    // САМОСТОЯТЕЛЬНО на forms.mchs.gov.ru; честная формулировка об этом —
    // в ответе ниже.
    const insertResult = await query<{
      id: string;
      status: MchsStatus;
      created_at: string;
    }>(
      `INSERT INTO mchs_registrations (
         operator_booking_id,
         operator_id,
         group_composition,
         route,
         start_date,
         end_date,
         guide_contacts,
         emergency_contacts,
         status,
         created_at,
         updated_at
       ) VALUES (
         $1::bigint, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8::jsonb,
         'pending', now(), now()
       )
       RETURNING id, status, created_at`,
      [
        data.bookingId,
        operatorId,
        JSON.stringify(data.groupComposition),
        data.route,
        data.startDate,
        data.endDate,
        JSON.stringify(data.guideContacts),
        JSON.stringify(data.emergencyContacts),
      ]
    );

    const created = insertResult.rows[0];

    return NextResponse.json(
      {
        success: true,
        data: {
          id: created.id,
          bookingId: String(data.bookingId),
          status: created.status,
          createdAt: created.created_at,
        },
        // Честно: этот эндпоинт не отправляет данные в МЧС (§10 CLAUDE.md
        // сам называет раздел «заготовкой» — автоматической интеграции нет,
        // TODO на самостоятельную регистрацию через наш интерфейс). Раньше
        // сообщение звучало как «отправлено», хотя сохранялась только
        // внутренняя запись — оператор считал шаг выполненным и мог не
        // зарегистрировать группу нигде (аудит кабинета оператора).
        message:
          'Запись сохранена в кабинете. Автоматической отправки в МЧС пока нет — ' +
          'зарегистрируйте группу самостоятельно на forms.mchs.gov.ru или по телефону МЧС Камчатки.',
      } as ApiResponse<unknown>,
      { status: 201 }
    );
  } catch (error) {
    logMchsFailure('POST', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить регистрацию МЧС. Попробуйте ещё раз или обратитесь в поддержку.' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
