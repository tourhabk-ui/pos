import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { chatService } from '@/lib/services/operators/chat.service';
import { pool } from '@/lib/db-pool';
import { INBOX_CHAT_CATEGORIES } from '@/lib/crm/inbox-kinds';

export const dynamic = 'force-dynamic';

/**
 * GET /api/chat/conversations
 * List conversations for the authenticated user.
 */
export async function GET(request: NextRequest) {
  try {
    const userOrResponse = await requireAuth(request);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
    const offset = parseInt(searchParams.get('offset') || '0');

    const { conversations, total } = await chatService.listConversations({
      userId: userOrResponse.userId,
      limit,
      offset,
    });

    return NextResponse.json({
      success: true,
      data: { conversations, total },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки бесед', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}

/**
 * Тело POST. `tourId` и `bookingId` схема не читает намеренно (аудит 15.10,
 * P2-02): кнопка «Написать оператору» шлёт id тура, но беседа его не хранит —
 * колонки `conversations.tour_id`/`booking_id` на проде ссылаются на
 * запрещённые `tours`/`bookings` (uuid), и запись числового id тура роняла
 * создание беседы. Тур доходит до оператора темой (`subject`). Лишние ключи
 * z.object отбрасывает — кнопку менять не нужно.
 */
const CreateConversationSchema = z.object({
  participantId: z.string().trim().optional(),
  participantRole: z.string().optional(),
  subject: z.string().trim().optional(),
  message: z.string().trim().optional(),
  operatorPartnerId: z.string().trim().optional(),
});

/**
 * POST /api/chat/conversations
 * Create or find a direct conversation with another user.
 * Body: { participantId?, operatorPartnerId?, participantRole?, subject?, message? }
 */
export async function POST(request: NextRequest) {
  try {
    const userOrResponse = await requireAuth(request);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const parsed = CreateConversationSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Некорректные данные беседы' },
        { status: 400 }
      );
    }
    let participantId = parsed.data.participantId ?? '';
    let participantRole = parsed.data.participantRole ?? 'tourist';
    const subject = parsed.data.subject;
    const message = parsed.data.message;

    // Кнопка «Написать оператору» на карточке тура знает только id партнёра —
    // user_id оператора резолвим на сервере, чтобы не светить его в публичном API
    const operatorPartnerId = parsed.data.operatorPartnerId ?? '';
    if (!participantId && operatorPartnerId) {
      const { rows } = await pool.query<{ user_id: string | null; category: string | null }>(
        `SELECT user_id, category FROM partners WHERE id = $1 LIMIT 1`,
        [operatorPartnerId]
      );
      if (!rows[0]?.user_id) {
        return NextResponse.json(
          { success: false, error: 'У оператора нет аккаунта для сообщений. Свяжитесь с ним по телефону из карточки тура.' },
          { status: 404 }
        );
      }
      participantId = rows[0].user_id;
      // Роль собеседника — категория его карточки: тур продаёт и гид (1338).
      // По роли уведомление о сообщении и лента CRM ищут карточку
      // (lib/notifications/chat-message, lib/crm/chat-events); гид, записанный
      // «оператором», оставался без уведомления — карточки оператора у него нет.
      const category = rows[0].category;
      participantRole = category && (INBOX_CHAT_CATEGORIES as ReadonlySet<string>).has(category) ? category : 'operator';
    }

    if (!participantId) {
      return NextResponse.json(
        { success: false, error: 'participantId обязателен' },
        { status: 400 }
      );
    }

    if (participantId === userOrResponse.userId) {
      return NextResponse.json(
        { success: false, error: 'Нельзя создать беседу с самим собой' },
        { status: 400 }
      );
    }

    // Get or create direct conversation
    const { conversationId, created } = await chatService.getOrCreateDirect(
      userOrResponse.userId,
      userOrResponse.role,
      participantId,
      participantRole,
      { subject }
    );

    // Send initial message if provided and conversation was just created
    if (message && created) {
      await chatService.sendMessage({
        conversationId,
        senderId: userOrResponse.userId,
        content: message,
      });
    } else if (message && !created) {
      // Even if conversation exists, send the message
      await chatService.sendMessage({
        conversationId,
        senderId: userOrResponse.userId,
        content: message,
      });
    }

    return NextResponse.json({
      success: true,
      data: { conversationId, created },
    }, { status: created ? 201 : 200 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка создания беседы', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
