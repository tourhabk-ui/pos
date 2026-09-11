import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAdmin } from '@/lib/auth/middleware';
import { Partner, ApiResponse, PaginatedResponse, Asset, ContactInfo } from '@/types';
import { PartnerAdminRow, CountRow } from '@/lib/types/db-rows';
import { z } from 'zod';
import { slugify } from '@/lib/text/slugify';
import { safeMsg } from '@/lib/errors/sanitize';

export const dynamic = 'force-dynamic';
const ALLOWED_SORT_FIELDS = new Set(['created_at', 'updated_at', 'name', 'category', 'rating', 'review_count', 'is_verified']);

/**
 * GET /api/admin/content/partners
 * Получение списка партнёров для верификации
 */
export async function GET(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) {
      return adminOrResponse;
    }
    const { searchParams } = new URL(request.url);
    
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const offset = (page - 1) * limit;
    
    const category = searchParams.get('category');
    const verified = searchParams.get('verified');
    const search = searchParams.get('search');
    const requestedSortBy = searchParams.get('sortBy') || 'created_at';
    const sortBy = ALLOWED_SORT_FIELDS.has(requestedSortBy) ? requestedSortBy : 'created_at';
    const sortOrder = (searchParams.get('sortOrder') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const whereConditions: string[] = [];
    const queryParams: (string | number | boolean | null)[] = [];
    let paramIndex = 1;

    if (category) {
      whereConditions.push(`p.category = $${paramIndex}`);
      queryParams.push(category);
      paramIndex++;
    }

    if (verified !== null && verified !== undefined) {
      whereConditions.push(`p.is_verified = $${paramIndex}`);
      queryParams.push(verified === 'true');
      paramIndex++;
    }

    if (search) {
      whereConditions.push(`(p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0 
      ? `WHERE ${whereConditions.join(' AND ')}` 
      : '';

    // Подсчёт
    const countQuery = `
      SELECT COUNT(*)
      FROM partners p
      ${whereClause}
    `;

    const countResult = await query<CountRow>(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count);

    // Получение партнёров
    const partnersQuery = `
      SELECT
        p.id,
        p.name,
        p.category,
        p.description,
        p.contact,
        p.rating,
        p.review_count,
        p.is_verified,
        p.created_at,
        p.updated_at,
        l.url as logo_url
      FROM partners p
      LEFT JOIN assets l ON p.logo_asset_id = l.id
      ${whereClause}
      ORDER BY p.${sortBy} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);
    const partnersResult = await query<PartnerAdminRow>(partnersQuery, queryParams);

    const partners: Partner[] = partnersResult.rows.map(row => ({
      id: row.id,
      name: row.name,
      category: row.category as Partner['category'],
      description: row.description ?? '',
      contact: (row.contact ?? {}) as unknown as ContactInfo,
      rating: parseFloat(row.rating) || 0,
      reviewCount: parseInt(row.review_count) || 0,
      isVerified: row.is_verified,
      logo: row.logo_url ? {
        id: 'temp-id',
        url: row.logo_url,
        mimeType: 'image/jpeg',
        sha256: '',
        size: 0,
        createdAt: new Date()
      } : undefined,
      images: [] as Asset[],
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));

    const response: PaginatedResponse<Partner> = {
      data: partners,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };

    return NextResponse.json({
      success: true,
      data: response
    } as ApiResponse<PaginatedResponse<Partner>>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to fetch partners',
      message: error instanceof Error ? error.message : 'Unknown error'
    } as ApiResponse<null>, { status: 500 });
  }
}



/**
 * POST /api/admin/content/partners — завести партнёра руками.
 *
 * ── Почему этого не было ───────────────────────────────────────────────────
 *
 * До 11.09 партнёра нельзя было создать НИКАК, кроме как его собственной
 * регистрацией на сайте. Админка умела читать, править, проверять и удалять —
 * то есть всё, кроме первого шага. Обнаружилось прозаично: владелец прислал
 * логотип нового партнёра, и класть его оказалось некуда.
 *
 * Дыра не косметическая. Оператор, который договорился по телефону и не
 * собирается заводить аккаунт сам, не мог попасть на платформу вообще; а
 * единственная дверь — саморегистрация — сама была сломана полтора месяца
 * (42P08 в INSERT профиля, разбор 24.08), и никто этого не видел, потому что
 * запасного входа не существовало.
 *
 * ── Контакт обязателен, и это не формальность ──────────────────────────────
 *
 * Колонка `contact` и без того NOT NULL, но здесь требуется не «объект», а
 * хотя бы ОДИН непустой канал. Причина — замер 11.09
 * (`GET /api/cron/operator-reach`): у обоих операторов с живыми турами
 * достижимых каналов НОЛЬ, и двенадцать туров стоят за партнёрами, которым
 * заявка не дойдёт. Заводить тринадцатого с пустым контактом значит
 * повторять ту же ошибку осознанно.
 *
 * Пустой `{}` прошёл бы проверку типа и провалил бы дело. Это ровно §4.0:
 * поле, которое нельзя оставить честно пустым, заполняется пустышкой.
 *
 * ── Slug не выдумывается молча ─────────────────────────────────────────────
 *
 * Не задан — считается из названия (`slugify`, тот же, что у маршрутов и
 * мест). Занят — 409 с названием занятого, а НЕ тихое приписывание «-2»:
 * адрес карточки оператора видит человек, и выбирать его должен человек.
 */

export const CreatePartnerSchema = z.object({
  name: z.string().trim().min(2, 'Название обязательно'),
  category: z.enum(['operator', 'guide', 'transfer', 'agent', 'restaurant'], {
    message: 'Категория обязательна: оператор, гид, трансфер, агент или ресторан',
  }),
  description: z.string().optional().default(''),
  shortDescription: z.string().optional().default(''),
  slug: z.string().optional().default(''),
  contact: z
    .object({
      phone: z.string().optional(),
      email: z.string().optional(),
      website: z.string().optional(),
      address: z.string().optional(),
    })
    .refine(
      (c) => [c.phone, c.email, c.website].some((v) => (v ?? '').trim().length > 0),
      { message: 'Нужен хотя бы один способ связи: телефон, почта или сайт' },
    ),
  isPublic: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  const adminOrResponse = await requireAdmin(request);
  if (adminOrResponse instanceof NextResponse) return adminOrResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Тело запроса не разобрано' }, { status: 400 });
  }

  const parsed = CreatePartnerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  const { name, category, description, shortDescription, isPublic } = parsed.data;
  const contact = parsed.data.contact;
  const slug = (parsed.data.slug || slugify(name)).trim();
  if (!slug) {
    return NextResponse.json(
      { success: false, error: 'Из названия не вышло адреса — задайте slug вручную' },
      { status: 400 },
    );
  }

  try {
    // Ставка комиссии НЕ задаётся здесь намеренно: её назначает владелец
    // (разбор денежного пути 11.09), и колонка имеет умолчание. Пусть новый
    // партнёр получает то же, что все, а не то, что вписал заводящий.
    // `status` здесь НЕ пишется, хотя на проде колонка есть и по смыслу
    // просилась бы 'pending'. Причина процедурная и важнее удобства: у
    // `partners` нет CREATE TABLE ни в migrations/, ни в schema.sql (таблица
    // из замороженного списка §4), значит проверить колонку репозиторию
    // нечем — и сторож schema-usage это поймал. Умолчание колонки даёт ровно
    // то же 'pending', так что терять нечего, а писать в непроверяемое —
    // ровно та дорога, на которой ошибка доживает до прода.
    const result = await query<{ id: string }>(
      `INSERT INTO partners (name, category, description, short_description, slug, contact, is_public)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id`,
      [name, category, description || null, shortDescription || null, slug, JSON.stringify(contact), isPublic],
    );

    return NextResponse.json(
      {
        success: true,
        data: { id: result.rows[0].id, slug },
        message: 'Партнёр заведён. Логотип и фото загружаются в его карточке.',
      },
      { status: 201 },
    );
  } catch (error) {
    // 23505 — занятый slug. Уникальный индекс partners_slug_key существует, и
    // без этой ветки человек получил бы «ошибка создания» без единого слова
    // о том, что именно занято.
    const code = (error as { code?: string } | null)?.code;
    if (code === '23505') {
      return NextResponse.json(
        { success: false, error: `Адрес «${slug}» уже занят другим партнёром — задайте другой` },
        { status: 409 },
      );
    }
    console.error('[admin/partners] создание не удалось', { code, slug });
    return NextResponse.json(
      { success: false, error: 'Ошибка создания', details: safeMsg(error) },
      { status: 500 },
    );
  }
}
