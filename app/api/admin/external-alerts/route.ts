import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAdmin } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

/**
 * Ручное управление алертами безопасности (таблица external_alerts).
 * Автоконвейер (cron/safety-ingest) ловит только то, что есть в источниках;
 * разовые новости (дорожные ограничения от подрядчиков, распоряжения) админ
 * заводит здесь — дальше их разливает по точкам тот же safety-ingest, они
 * попадают в мобильный баннер, карточки точек и live-контекст Кузьмича.
 */

const ZONES = ['northern', 'eastern', 'western', 'avachinsky'] as const;
const ALERT_TYPES = ['road_closure', 'info', 'flood', 'fire_danger', 'volcanic_eruption', 'tsunami_warning'] as const;

const CreateAlertSchema = z.object({
  title: z.string().min(5, 'Заголовок минимум 5 символов').max(200),
  description: z.string().max(2000).optional(),
  alertType: z.enum(ALERT_TYPES, { errorMap: () => ({ message: 'Недопустимый тип алерта' }) }),
  severity: z.number().int().min(0).max(3),
  affectedZones: z.array(z.enum(ZONES)).min(1, 'Укажите хотя бы одну зону'),
  expiresAt: z.string().datetime({ offset: true, message: 'expiresAt — ISO дата со смещением' }),
  sourceUrl: z.string().url().optional(),
  externalId: z.string().max(100).optional(),
});

function slugify(title: string): string {
  return title.toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * GET /api/admin/external-alerts - Активные алерты (ручные и автоматические)
 */
export async function GET(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const result = await query(
      `SELECT id, alert_type, severity, title, description, affected_zones,
              created_at, expires_at, source_url, external_id
       FROM external_alerts
       WHERE expires_at > NOW()
       ORDER BY severity DESC, created_at DESC
       LIMIT 100`
    );

    return NextResponse.json({
      success: true,
      data: { alerts: result.rows, count: result.rows.length }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении алертов' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/external-alerts - Создать ручной алерт
 */
export async function POST(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const body = await request.json();
    const parsed = CreateAlertSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const { title, description, alertType, severity, affectedZones, expiresAt, sourceUrl, externalId } = parsed.data;

    const expires = new Date(expiresAt);
    if (expires.getTime() <= Date.now()) {
      return NextResponse.json(
        { success: false, error: 'expiresAt должен быть в будущем' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const externalIdFinal = externalId || `manual-${slugify(title)}`;

    const result = await query(
      `INSERT INTO external_alerts (
        alert_type, severity, title, description,
        affected_zones, created_at, expires_at, source_url, external_id
      ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
      ON CONFLICT (external_id) DO NOTHING
      RETURNING id`,
      [alertType, severity, title, description ?? '', affectedZones, expires, sourceUrl ?? null, externalIdFinal]
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: `Алерт с external_id «${externalIdFinal}» уже существует` } as ApiResponse<null>,
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      data: { id: result.rows[0].id, externalId: externalIdFinal },
      message: 'Алерт создан. Точки зоны обновятся при ближайшем safety-ingest (до 5 минут).'
    } as ApiResponse<unknown>, { status: 201 });

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при создании алерта' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
