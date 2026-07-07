import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiResponse } from '@/types';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { ensurePartnerForRole } from '@/lib/auth/partner-profile';
import { getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const validRoles = ['tourist', 'operator', 'guide', 'transfer', 'agent', 'admin', 'stay', 'gear'] as const;
const validLevels = ['L1', 'L2', 'L3'] as const;

const UpdateRoleSchema = z.object({
  userId: z.string().uuid('Укажите корректный ID пользователя'),
  role: z.enum(validRoles as unknown as [string, ...string[]], { errorMap: () => ({ message: 'Указана недопустимая роль' }) }),
  level: z.enum(validLevels as unknown as [string, ...string[]], { errorMap: () => ({ message: 'Указан недопустимый уровень оператора' }) }).optional(),
  permissions: z.array(z.string()).optional(),
});

// GET /api/roles - Public
export async function GET(request: NextRequest) {
  try {
    const roles = [
      {
        id: 'tourist',
        name: 'Турист',
        description: 'Планирование и бронирование туров, получение рекомендаций',
        permissions: [
          'view_tours',
          'book_tours',
          'view_weather',
          'use_ai_chat',
          'view_reviews',
          'manage_profile',
        ],
        features: [
          'Поиск и фильтрация туров',
          'Бронирование и оплата',
          'AI-помощник для планирования',
          'Прогноз погоды и рекомендации',
          'Отзывы и рейтинги',
          'Мобильное приложение',
        ],
        dashboard: '/hub/tourist',
      },
      {
        id: 'operator',
        name: 'Туроператор',
        description: 'Управление турами, слотами, гидами и аналитикой',
        permissions: [
          'manage_tours',
          'manage_slots',
          'manage_guides',
          'view_analytics',
          'manage_bookings',
          'manage_weather',
          'manage_transfers',
        ],
        features: [
          'CRM система для управления',
          'Создание и редактирование туров',
          'Управление расписанием и слотами',
          'Аналитика и отчеты',
          'Управление гидами',
          'Система уведомлений',
        ],
        dashboard: '/hub/operator',
        levels: [
          {
            level: 'L1',
            name: 'Базовый',
            description: 'Управление турами и слотами',
            features: ['Создание туров', 'Управление слотами', 'Базовые отчеты'],
          },
          {
            level: 'L2',
            name: 'Партнерский',
            description: 'Лиды, платежи, чаты',
            features: ['Обработка лидов', 'Платежная система', 'Чат с клиентами'],
          },
          {
            level: 'L3',
            name: 'Официальный',
            description: 'AI, мобильное приложение, API',
            features: ['AI-ассистент', 'Мобильное приложение', 'API интеграции'],
          },
        ],
      },
      {
        id: 'guide',
        name: 'Гид',
        description: 'Управление расписанием, группами и доходами',
        permissions: [
          'view_schedule',
          'manage_groups',
          'view_earnings',
          'update_availability',
          'view_weather',
          'communicate_with_tourists',
        ],
        features: [
          'Календарь туров и расписание',
          'Управление группами туристов',
          'Отслеживание доходов',
          'Планирование отпусков',
          'Связь с туристами',
          'Рейтинги и отзывы',
        ],
        dashboard: '/hub/guide',
      },
      {
        id: 'transfer',
        name: 'Владелец трансфера',
        description: 'Управление маршрутами, транспортом и водителями',
        permissions: [
          'manage_routes',
          'manage_vehicles',
          'manage_drivers',
          'manage_schedules',
          'view_analytics',
          'manage_weather',
        ],
        features: [
          'Создание и управление маршрутами',
          'Регистрация транспортных средств',
          'Управление водителями',
          'Система бронирования мест',
          'Аналитика загрузки',
          'Интеграция с турами',
        ],
        dashboard: '/hub/transfer-operator',
      },
      {
        id: 'agent',
        name: 'Агент',
        description: 'Управление группами, ваучерами и партнерствами',
        permissions: [
          'manage_groups',
          'manage_vouchers',
          'view_commissions',
          'manage_partnerships',
          'view_analytics',
          'gds_integration',
        ],
        features: [
          'Создание групповых туров',
          'Система ваучеров',
          'Управление комиссиями',
          'GDS интеграции',
          'B2B платформы',
          'Белые метки',
        ],
        dashboard: '/hub/agent',
      },
      {
        id: 'stay',
        name: 'Владелец жилья',
        description: 'Управление объектами размещения и бронями гостей',
        permissions: [
          'manage_accommodations',
          'manage_stay_bookings',
          'view_stay_stats',
          'manage_profile',
        ],
        features: [
          'Редактирование объектов размещения',
          'Публикация и снятие с витрины',
          'Подтверждение и ведение броней',
          'Учёт заездов и no-show',
          'Статистика по броням и выручке',
        ],
        dashboard: '/hub/stay',
      },
      {
        id: 'gear',
        name: 'Прокат снаряжения',
        description: 'Управление инвентарём и заявками на аренду снаряжения',
        permissions: [
          'manage_gear_items',
          'manage_gear_rentals',
          'view_gear_stats',
          'manage_profile',
        ],
        features: [
          'Инвентарь: добавление и редактирование позиций',
          'Публикация на витрине аренды',
          'Подтверждение и ведение аренд',
          'Учёт выдачи и возврата',
          'Статистика по выручке и топ-позициям',
        ],
        dashboard: '/hub/gear',
      },
      {
        id: 'admin',
        name: 'Администратор',
        description: 'Системное управление, мониторинг и аналитика',
        permissions: [
          'manage_users',
          'manage_roles',
          'system_monitoring',
          'weather_management',
          'inter_operator_management',
          'full_analytics',
        ],
        features: [
          'Управление пользователями и ролями',
          'Системный мониторинг',
          'Управление погодными условиями',
          'Межоператорские партнерства',
          'Полная аналитика платформы',
          'Безопасность и аудит',
        ],
        dashboard: '/hub/admin',
      },
    ];

    return NextResponse.json({
      success: true,
      data: roles,
} as ApiResponse<typeof roles>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to fetch roles',
      message: error instanceof Error ? error.message : 'Unknown error',
    } as ApiResponse<null>, { status: 500 });
  }
}

// POST /api/roles - Обновление роли пользователя (admin only)
export async function POST(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({
        success: false,
        error: 'Неверный формат запроса',
      } as ApiResponse<null>, { status: 400 });
    }

    const validationResult = UpdateRoleSchema.safeParse(body);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors[0]?.message || 'Ошибка валидации';
      return NextResponse.json({
        success: false,
        error: errorMessage,
      } as ApiResponse<null>, { status: 400 });
    }

    const { userId, role, level } = validationResult.data;

    // Валидация уровня для операторов
    if (role === 'operator' && level) {
      if (!validLevels.includes(level as 'L1' | 'L2' | 'L3')) {
        return NextResponse.json({
          success: false,
          error: 'Указан недопустимый уровень оператора',
        } as ApiResponse<null>, { status: 400 });
      }
    }

    // Смена роли: users.role + добавление в preferences.roles (мультироли),
    // уровень оператора — в preferences.operator_level
    const updateResult = await query<{ id: string; email: string; name: string; role: string; preferences: unknown }>(
      `UPDATE users
       SET role = $2,
           preferences = jsonb_set(
             CASE WHEN $3::text IS NULL
                  THEN COALESCE(preferences, '{}'::jsonb)
                  ELSE jsonb_set(COALESCE(preferences, '{}'::jsonb), '{operator_level}', to_jsonb($3::text))
             END,
             '{roles}',
             CASE WHEN COALESCE(preferences->'roles', '[]'::jsonb) ? $2
                  THEN COALESCE(preferences->'roles', '[]'::jsonb)
                  ELSE COALESCE(preferences->'roles', '[]'::jsonb) || to_jsonb($2::text)
             END
           ),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, role, preferences`,
      [userId, role, level ?? null]
    );

    if (updateResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Пользователь не найден',
      } as ApiResponse<null>, { status: 404 });
    }

    // Партнёрским ролям — партнёрский профиль (иначе кабинет пуст)
    const partnerId = await ensurePartnerForRole(userId, role);

    // Аудит смены роли; сбой аудита не блокирует ответ
    await query(
      `INSERT INTO audit_log (entity_type, entity_id, action, data, ip_address, created_at)
       VALUES ('user', $1, 'role_change', $2, $3, NOW())`,
      [
        userId,
        JSON.stringify({ role, level: level || null, changedBy: adminOrResponse.userId }),
        getClientIp(request.headers),
      ]
    ).catch(() => {});

    const updated = updateResult.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        userId: updated.id,
        role: updated.role,
        level: level || null,
        partnerId,
        message: 'Роль пользователя обновлена',
      },
    } as ApiResponse<{ userId: string; role: string; level: string | null; partnerId: string | null; message: string }>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to update role',
      message: error instanceof Error ? error.message : 'Unknown error',
    } as ApiResponse<null>, { status: 500 });
  }
}