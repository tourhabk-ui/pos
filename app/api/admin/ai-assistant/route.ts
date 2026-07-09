import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { callAIWithModelDirect } from '@/lib/ai/providers';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const AssistantSchema = z.object({
  message: z.string().min(1).max(4000),
  // История чата: [{role, content}] — форма сообщений передаётся в waterfall как есть.
  context: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().max(8000),
  })).max(30).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const parsed = AssistantSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: 'Message is required' }, { status: 400 });
    }
    const { message, context } = parsed.data;

    // Получаем контекст платформы из БД
    const [bookingsResult, toursResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM operator_bookings'),
      pool.query('SELECT COUNT(*) as total FROM operator_tours WHERE is_active = true'),
    ]);

    const platformContext = {
      totalBookings: bookingsResult.rows[0]?.total ?? 0,
      activeTours: toursResult.rows[0]?.total ?? 0,
    };

    const systemPrompt = `Ты AI-ассистент администратора туристической платформы TourHab (Камчатка).

Контекст платформы:
- Всего бронирований: ${platformContext.totalBookings}
- Активных туров: ${platformContext.activeTours}

Ты помогаешь администратору управлять платформой: анализировать данные, отвечать на вопросы о бизнес-метриках, помогать с модерацией контента и принятием решений.

Отвечай кратко и по делу. Без эмодзи.`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...(context ?? []),
      { role: 'user' as const, content: message },
    ];

    const response = await callAIWithModelDirect(messages, 'fast');

    return NextResponse.json({
      success: true,
      data: { response },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'AI assistant error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
