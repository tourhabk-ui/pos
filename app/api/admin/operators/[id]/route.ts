/**
 * PATCH /api/admin/operators/[id]
 * Одобрить или отклонить заявку оператора
 * action: 'approve' | 'reject'
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { z } from 'zod';
import { emailService } from '@/lib/notifications/email-service';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  action:  z.enum(['approve', 'reject']),
  comment: z.string().max(1000).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Некорректный идентификатор партнёра' }, { status: 400 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 });

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const { action, comment } = parsed.data;

  // Получаем данные партнёра + пользователя
  const partnerRes = await query(`
    SELECT p.id, p.name AS company_name, p.profile_status, p.category,
           u.id AS user_id, u.email, u.name AS contact_name
    FROM partners p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = $1
  `, [id]);

  if (partnerRes.rows.length === 0) {
    return NextResponse.json({ error: 'Партнёр не найден' }, { status: 404 });
  }

  const partner = partnerRes.rows[0] as {
    id: string; company_name: string; profile_status: string; category: string;
    user_id: string; email: string; contact_name: string;
  };

  // Очередь общая для всех партнёров (гиды в ней с пакета A, 25.09): текст
  // письма обязан говорить о том, что одобрено. Гиду «публикуйте туры» и
  // ссылка в кабинет оператора — неправда.
  const isGuide = partner.category === 'guide';
  const logSendFailure = (channel: string) => (err: unknown) => {
    console.error(`[admin/operators] ${channel} о решении не отправлено:`, `partner=${id}`,
      err instanceof Error ? err.message : String(err));
  };

  if (action === 'approve') {
    await query(`
      UPDATE partners
      SET profile_status = 'approved',
          is_verified    = TRUE,
          is_public      = TRUE,
          verified_at    = NOW(),
          verified_by    = $2,
          updated_at     = NOW()
      WHERE id = $1
    `, [id, authOrResponse.userId]);

    // Обновляем operator_applications
    await query(`
      UPDATE operator_applications
      SET status      = 'approved',
          reviewed_by = $2,
          reviewed_at = NOW()
      WHERE partner_id = $1
    `, [id, authOrResponse.userId]);

    // Email оператору
    emailService.sendEmail({
      to: partner.email,
      subject: isGuide ? 'Профиль гида одобрен — Ведар' : 'Ваша заявка одобрена — TourHub',
      html: isGuide
        ? `<p>Здравствуйте, <b>${partner.contact_name}</b>!</p>
             <p>Профиль гида <b>${partner.company_name}</b> проверен и одобрен. Теперь он виден туристам в реестре гидов.</p>
             <p><a href="https://vedarai.ru/guides/${partner.id}">Открыть профиль на сайте →</a></p>`
        : `<p>Здравствуйте, <b>${partner.contact_name}</b>!</p>
             <p>Заявка компании <b>${partner.company_name}</b> одобрена. Теперь вы можете публиковать туры.</p>
             <p><a href="https://vedarai.ru/hub/operator">Перейти в кабинет →</a></p>`,
    }).catch(logSendFailure('email'));

    // Telegram уведомление оператору если есть chat_id
    const tgRes = await query(
      `SELECT contacts->>'telegram_chat_id' AS chat_id FROM partners WHERE id = $1`,
      [id]
    );
    const chatId = (tgRes.rows[0] as { chat_id: string | null })?.chat_id;
    if (chatId) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (token) {
        fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: isGuide
              ? `Ваш профиль гида одобрен и виден туристам в реестре гидов.\nhttps://vedarai.ru/guides/${partner.id}`
              : `Ваша заявка одобрена! Теперь вы можете публиковать туры на TourHub.\nhttps://vedarai.ru/hub/operator`,
          }),
        }).catch(logSendFailure('telegram'));
      }
    }

    return NextResponse.json({ success: true, message: isGuide ? 'Гид одобрен' : 'Оператор одобрен' });

  } else {
    await query(`
      UPDATE partners
      SET profile_status        = 'rejected',
          profile_review_comment = $2,
          updated_at            = NOW()
      WHERE id = $1
    `, [id, comment ?? null]);

    await query(`
      UPDATE operator_applications
      SET status         = 'rejected',
          review_comment = $2,
          reviewed_by    = $3,
          reviewed_at    = NOW()
      WHERE partner_id = $1
    `, [id, comment ?? null, authOrResponse.userId]);

    emailService.sendEmail({
      to: partner.email,
      subject: 'Статус заявки — TourHub',
      html: `<p>Здравствуйте, <b>${partner.contact_name}</b>!</p>
             <p>К сожалению, ${isGuide ? 'профиль гида' : 'заявка компании'} <b>${partner.company_name}</b> не прошла проверку.</p>
             ${isGuide ? '<p>Исправьте профиль в кабинете гида и отправьте его на проверку снова.</p>' : ''}
             ${comment ? `<p><b>Комментарий:</b> ${comment}</p>` : ''}
             <p>По вопросам: <a href="mailto:info@vedarai.ru">info@vedarai.ru</a></p>`,
    }).catch(logSendFailure('email'));

    return NextResponse.json({ success: true, message: 'Заявка отклонена' });
  }
}
