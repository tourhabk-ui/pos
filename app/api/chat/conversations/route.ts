import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { chatService } from '@/lib/services/operators/chat.service';
import { pool } from '@/lib/db-pool';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { CHAT_NO_PARTNER_TEXT, INBOX_CHAT_CATEGORIES } from '@/lib/crm/inbox-kinds';

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
    logSwallowedFailure('chat/conversations', 'список бесед', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки бесед' },
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
 *
 * Собеседник — только карточка партнёра (`operatorPartnerId`), его аккаунт и
 * роль сервер берёт из `partners` (ревью безопасности #3701, 22.11). До этого
 * дверь принимала из тела `participantId` и `participantRole`: любой вошедший
 * (турист регистрируется сам) открывал беседу с любым аккаунтом по его номеру
 * и сам называл его роль — а по роли уведомление и лента CRM ищут карточку.
 * Производителя у этих полей не было: единственная кнопка
 * (`components/marketplace/MessageOperatorButton.tsx`) шлёт номер карточки.
 * Теперь они отбрасываются, как любые лишние ключи.
 */
const CreateConversationSchema = z.object({
  subject: z.string().trim().optional(),
  message: z.string().trim().optional(),
  operatorPartnerId: z.string().trim().uuid(),
});

/**
 * POST /api/chat/conversations
 * Найти или открыть беседу туриста с компанией по номеру её карточки.
 * Body: { operatorPartnerId, subject?, message? }
 */
export async function POST(request: NextRequest) {
  try {
    const userOrResponse = await requireAuth(request);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const body: unknown = await request.json().catch(() => null);
    const parsed = CreateConversationSchema.safeParse(body);
    if (!parsed.success) {
      const noPartner = parsed.error.issues.some((i) => i.path[0] === 'operatorPartnerId' && i.code === 'invalid_type');
      return NextResponse.json(
        { success: false, error: noPartner ? CHAT_NO_PARTNER_TEXT : 'Некорректные данные беседы' },
        { status: 400 }
      );
    }
    const subject = parsed.data.subject;
    const message = parsed.data.message;

    // Кнопка «Написать оператору» на карточке тура знает только id партнёра —
    // user_id оператора резолвим на сервере, чтобы не светить его в публичном API
    const { rows } = await pool.query<{ user_id: string | null; category: string | null }>(
      `SELECT user_id, category FROM partners WHERE id = $1 LIMIT 1`,
      [parsed.data.operatorPartnerId]
    );
    if (!rows[0]?.user_id) {
      return NextResponse.json(
        { success: false, error: 'У оператора нет аккаунта для сообщений. Свяжитесь с ним по телефону из карточки тура.' },
        { status: 404 }
      );
    }
    const participantId = rows[0].user_id;
    // Роль собеседника — категория его карточки: тур продаёт и гид (1338).
    // По роли уведомление о сообщении и лента CRM ищут карточку
    // (lib/notifications/chat-message, lib/crm/chat-events); гид, записанный
    // «оператором», оставался без уведомления — карточки оператора у него нет.
    const category = rows[0].category;
    const participantRole = category && (INBOX_CHAT_CATEGORIES as ReadonlySet<string>).has(category) ? category : 'operator';

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
    logSwallowedFailure('chat/conversations', 'создание беседы', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка создания беседы' },
      { status: 500 }
    );
  }
}
