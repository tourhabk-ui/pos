import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { Partner, ApiResponse, PaginatedResponse } from '@/types';
import { requireAdmin } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';
const ALLOWED_SORT_FIELDS = new Set(['created_at', 'updated_at', 'name', 'category', 'rating', 'review_count', 'is_verified']);

/**
 * Публичная карточка партнёра — без контактов.
 *
 * До 15.10 этот роут отдавал анониму `partners.contact` целиком (почта,
 * телефон, Telegram) по всем партнёрам, включая физлиц, зарегистрировавшихся
 * самостоятельно (гиды, владельцы жилья), — а на первой странице прода было
 * 6 адресов почты и 6 телефонов (замер 15.10, добор аудита архитектуры, ПД в
 * публичных ответах). Связь с партнёром — через заявку и страницу оператора,
 * где контакты оператор публикует сам; здесь их нет вовсе, и в SELECT их нет,
 * чтобы следующая правка не вернула поле в ответ (pd-guard: «лишнее убирать из
 * SELECT, а не только из ответа»). Список — только публичные карточки.
 */
type PublicPartner = Omit<Partner, 'contact'>;

const MAX_LIMIT = 50;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// GET /api/partners - Получение списка партнеров (каталог)
// PUBLIC: endpoint intentionally public for partner catalog browsing
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = clampInt(searchParams.get('page'), 1, 1, 10_000);
    const limit = clampInt(searchParams.get('limit'), 10, 1, MAX_LIMIT);
    const category = searchParams.get('category');
    const verified = searchParams.get('verified');
    const search = searchParams.get('search');
    const requestedSortBy = searchParams.get('sortBy') || 'created_at';
    const sortBy = ALLOWED_SORT_FIELDS.has(requestedSortBy) ? requestedSortBy : 'created_at';
    const sortOrder = (searchParams.get('sortOrder') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Строим WHERE условия. Аноним видит только публичные карточки.
    const whereConditions: string[] = ['is_public = true'];
    const queryParams: unknown[] = [];
    let paramIndex = 1;

    if (category) {
      whereConditions.push(`category = $${paramIndex}`);
      queryParams.push(category);
      paramIndex++;
    }

    if (verified !== null) {
      whereConditions.push(`is_verified = $${paramIndex}`);
      queryParams.push(verified === 'true');
      paramIndex++;
    }

    if (search) {
      whereConditions.push(`(name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Подсчитываем общее количество
    const countQuery = `
      SELECT COUNT(*) as total
      FROM partners
      ${whereClause}
    `;
    
    const countResult = await query<{ total: string }>(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].total);

    // Получаем партнеров с пагинацией
    const offset = (page - 1) * limit;
    const partnersQuery = `
      SELECT 
        p.id,
        p.name,
        p.category,
        p.description,
        p.rating,
        p.review_count,
        p.is_verified,
        p.created_at,
        p.updated_at,
        array_agg(DISTINCT a.url) as images,
        l.url as logo_url
      FROM partners p
      LEFT JOIN partner_assets pa ON p.id = pa.partner_id
      LEFT JOIN assets a ON pa.asset_id = a.id
      LEFT JOIN assets l ON p.logo_asset_id = l.id
      ${whereClause}
      GROUP BY p.id, l.url
      ORDER BY p.${sortBy} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);
    const partnersResult = await query<{
      id: string; name: string; category: string; description: string | null;
      rating: string | null; review_count: string;
      is_verified: boolean; created_at: string; updated_at: string;
      images: (string | null)[] | null; logo_url: string | null;
    }>(partnersQuery, queryParams);

    const partners: PublicPartner[] = partnersResult.rows.map(row => ({
      id: row.id,
      name: row.name,
      category: row.category as Partner['category'],
      description: row.description ?? '',
      rating: parseFloat(row.rating ?? '0'),
      reviewCount: parseInt(row.review_count),
      isVerified: row.is_verified,
      logo: row.logo_url ? {
        id: 'temp-id',
        url: row.logo_url,
        mimeType: 'image/jpeg',
        sha256: '',
        size: 0,
        createdAt: new Date()
      } : undefined,
      images: (row.images ?? []).filter((url): url is string => !!url).map((url) => ({
        id: 'temp-id',
        url,
        mimeType: 'image/jpeg',
        sha256: '',
        size: 0,
        createdAt: new Date()
      })),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));

    const response: PaginatedResponse<PublicPartner> = {
      data: partners,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    return NextResponse.json({
      success: true,
      data: response,
    } as ApiResponse<PaginatedResponse<PublicPartner>>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to fetch partners',
      message: error instanceof Error ? error.message : 'Unknown error',
    } as ApiResponse<null>, { status: 500 });
  }
}

// POST /api/partners - Создание нового партнера
export async function POST(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const body = await request.json();
    
    // Валидация обязательных полей
    const requiredFields = ['name', 'category', 'description', 'contact'];
    for (const field of requiredFields) {
      if (!body[field]) {
        return NextResponse.json({
          success: false,
          error: `Missing required field: ${field}`,
        } as ApiResponse<null>, { status: 400 });
      }
    }

    // Валидация категории
    const validCategories = ['operator', 'guide', 'transfer', 'stay', 'souvenir', 'gear', 'cars', 'restaurant'];
    if (!validCategories.includes(body.category)) {
      return NextResponse.json({
        success: false,
        error: `Invalid category. Must be one of: ${validCategories.join(', ')}`,
      } as ApiResponse<null>, { status: 400 });
    }

    // Создаем партнера
    const createPartnerQuery = `
      INSERT INTO partners (
        name, category, description, contact, is_verified
      ) VALUES (
        $1, $2, $3, $4, $5
      ) RETURNING id, created_at
    `;

    const partnerParams = [
      body.name,
      body.category,
      body.description,
      JSON.stringify(body.contact),
      body.isVerified || false,
    ];

    const result = await query(createPartnerQuery, partnerParams);
    const partnerId = result.rows[0].id;

    // Если есть логотип, связываем его с партнером
    if (body.logoUrl) {
      await query(
        'UPDATE partners SET logo_asset_id = (SELECT id FROM assets WHERE url = $1) WHERE id = $2',
        [body.logoUrl, partnerId]
      );
    }

    // Если есть изображения, связываем их с партнером
    if (body.images && body.images.length > 0) {
      for (const imageUrl of body.images) {
        await query(
          'INSERT INTO partner_assets (partner_id, asset_id) VALUES ($1, (SELECT id FROM assets WHERE url = $2))',
          [partnerId, imageUrl]
        );
      }
    }

    return NextResponse.json({
      success: true,
      data: { id: partnerId, createdAt: result.rows[0].created_at },
      message: 'Partner created successfully',
    } as ApiResponse<{ id: string; createdAt: Date }>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to create partner',
      message: error instanceof Error ? error.message : 'Unknown error',
    } as ApiResponse<null>, { status: 500 });
  }
}