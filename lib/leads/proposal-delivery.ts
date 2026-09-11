/**
 * Доставка AI-предложения клиенту — ЕДИНСТВЕННАЯ реализация.
 *
 * Зовут двое: HTTP-ручка POST /api/leads/[id]/proposal/send (кабинет) и
 * обработчик нажатия кнопки в Telegram (владелец одобряет прямо в
 * мессенджере, задача #65). Два способа отправки разошлись бы поведением —
 * это ровно тот случай, который правило «одна мера в одном месте» и
 * запрещает: клиент получил бы разные письма в зависимости от того, откуда
 * нажали.
 *
 * Авторизация СЮДА НЕ ВХОДИТ и входить не должна: у ручки это requireOperator,
 * у кнопки — принадлежность сообщения админ-чату. Каждый вызывающий обязан
 * проверить право сам ДО вызова.
 */

import { pool } from '@/lib/db-pool';
import { leadProcessor } from '@/lib/services/operators/lead-processor.service';
import { getPublicBaseUrl } from '@/lib/config';
import { sendEmail } from '@/lib/email';

export type DeliveryChannel = 'telegram' | 'email' | 'both';

export type DeliveryOutcome =
  | { ok: true; sent: string[]; failed: string[]; pdfUrl: string; message: string }
  | {
      ok: false;
      reason: 'not_found' | 'no_proposal' | 'already_sent' | 'proposal_missing' | 'not_delivered' | 'no_recipient';
      message: string;
    };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function tgSend(chatId: string | number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Отправить готовое предложение клиенту и перевести лид в proposal_sent.
 *
 * Идемпотентность: статус лида — сторож. Повторный вызов (второе нажатие
 * кнопки, ретрай Telegram) вернёт already_sent и НИЧЕГО не отправит: клиент
 * не должен получить одно предложение дважды.
 *
 * Сторож работает ЗАХВАТОМ, а не чтением (эволюция, 22.08). Прежде статус
 * читался в начале, а писался в конце — между ними лежала отправка в
 * Telegram. Два одновременных вызова (двойное нажатие, ретрай кнопки) оба
 * видели «ещё не отправлено» и оба отправляли: ровно то, что этот файл
 * обещает не допускать. Теперь лид ЗАНИМАЕТСЯ условным UPDATE до отправки:
 * второй вызов не находит строки и уходит с already_sent.
 *
 * Захват откатывается, если доставить не удалось НИЧЕМ: иначе сбой Telegram
 * навсегда пометил бы лид отправленным, и клиент не получил бы предложение
 * никогда — молчаливая потеря вместо честного «не смог» (§4.0).
 */
export async function sendProposalToClient(
  leadId: string,
  channel: DeliveryChannel = 'both',
): Promise<DeliveryOutcome> {
  const { rows } = await pool.query<{
    proposal_id: string | null;
    name: string;
    email: string | null;
    status: string;
    tg_chat_id: string | null;
  }>(
    `SELECT proposal_id, name, email, status,
            (source_data->>'tg_chat_id') AS tg_chat_id
       FROM leads WHERE id = $1`,
    [leadId],
  );

  const lead = rows[0];
  if (!lead) {
    return { ok: false, reason: 'not_found', message: 'Лид не найден' };
  }
  if (!lead.proposal_id) {
    return { ok: false, reason: 'no_proposal', message: 'Предложение ещё не сформировано. Запустите AI-обработку.' };
  }
  if (lead.status === 'proposal_sent') {
    return { ok: false, reason: 'already_sent', message: 'Предложение уже было отправлено.' };
  }

  const proposal = await leadProcessor.getProposal(lead.proposal_id);
  if (!proposal) {
    return { ok: false, reason: 'proposal_missing', message: 'Данные предложения не найдены.' };
  }

  // Захват: перевести лид в proposal_sent МОЖЕТ только один вызов. Проверка
  // выше — для внятного сообщения, а гонку закрывает именно это условие.
  const claim = await pool.query<{ prev_status: string }>(
    `WITH prev AS (SELECT status FROM leads WHERE id = $1)
     UPDATE leads SET status = 'proposal_sent', updated_at = NOW()
      WHERE id = $1 AND status IS DISTINCT FROM 'proposal_sent'
     RETURNING (SELECT status FROM prev) AS prev_status`,
    [leadId],
  );
  if (claim.rowCount === 0) {
    return { ok: false, reason: 'already_sent', message: 'Предложение уже было отправлено.' };
  }
  const prevStatus = claim.rows[0].prev_status;

  /** Вернуть лид в прежний статус: доставки не было, повтор должен быть возможен. */
  const releaseClaim = async () => {
    await pool.query(
      `UPDATE leads SET status = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'proposal_sent'`,
      [leadId, prevStatus],
    );
  };

  const pdfUrl = `${getPublicBaseUrl()}/api/leads/${leadId}/proposal/pdf`;
  const sent: string[] = [];
  const failed: string[] = [];

  if ((channel === 'telegram' || channel === 'both') && lead.tg_chat_id) {
    const tourLine = proposal.primary_tour
      ? `\n<b>Тур:</b> ${esc(proposal.primary_tour.title)} — ${proposal.primary_tour.price.toLocaleString('ru-RU')} р/чел`
      : '';
    const priceLine = proposal.price_from
      ? `\n<b>Бюджет:</b> от ${proposal.price_from.toLocaleString('ru-RU')} р`
      : '';
    const highlights = proposal.highlights.slice(0, 3).map((h) => `- ${esc(h)}`).join('\n');

    const text = [
      `<b>Предложение для ${esc(lead.name)}</b>`,
      '',
      `<b>${esc(proposal.headline)}</b>`,
      '',
      esc(proposal.summary),
      '',
      highlights,
      tourLine,
      priceLine,
      '',
      `<a href="${pdfUrl}">Скачать полное предложение PDF</a>`,
    ].filter((l) => l !== undefined).join('\n');

    if (await tgSend(lead.tg_chat_id, text)) sent.push('telegram');
    else failed.push('telegram');
  }

  if ((channel === 'email' || channel === 'both') && lead.email) {
    /*
     * Письмо отправляется ПО-НАСТОЯЩЕМУ.
     *
     * До 11.09 здесь стояло `sent.push('email_queued')` — строка без единого
     * вызова отправки, и это было худшее враньё во всём пути лида. У лида с
     * почтой и без Telegram список отправленных получался непустым: функция
     * возвращала успех, лид уходил в `proposal_sent`, оператор читал
     * «Предложение отправлено клиенту». Не отправлялось НИЧЕГО. Турист ждал
     * письма, которого никто не послал, а лид числился обработанным — к нему
     * больше не возвращались. §4.0: «не смог» выдавалось за «хорошо», и
     * платил за это живой человек.
     *
     * Отправщик в платформе был всё это время (`lib/email.ts`, SMTP Timeweb,
     * им же пользуется эскалация маршрутов). Он честен сам: без SMTP-настроек
     * отвечает «SMTP не настроен», на отказ сервера — его текстом. Здесь
     * результат уважается: успех — в `sent`, отказ — в `failed` и в лог.
     */
    const lines = [
      `Здравствуйте, ${lead.name}!`,
      '',
      proposal.headline,
      '',
      proposal.summary,
      '',
      ...proposal.highlights.slice(0, 3).map((h) => `- ${h}`),
      proposal.primary_tour
        ? `\nТур: ${proposal.primary_tour.title} — ${proposal.primary_tour.price.toLocaleString('ru-RU')} р/чел`
        : '',
      proposal.price_from ? `Бюджет: от ${proposal.price_from.toLocaleString('ru-RU')} р` : '',
      '',
      `Полное предложение в PDF: ${pdfUrl}`,
    ].filter(Boolean);

    const html = [
      `<p>Здравствуйте, ${esc(lead.name)}!</p>`,
      `<p><b>${esc(proposal.headline)}</b></p>`,
      `<p>${esc(proposal.summary)}</p>`,
      proposal.highlights.length > 0
        ? `<ul>${proposal.highlights.slice(0, 3).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`
        : '',
      proposal.primary_tour
        ? `<p><b>Тур:</b> ${esc(proposal.primary_tour.title)} — ${proposal.primary_tour.price.toLocaleString('ru-RU')} р/чел</p>`
        : '',
      proposal.price_from ? `<p><b>Бюджет:</b> от ${proposal.price_from.toLocaleString('ru-RU')} р</p>` : '',
      `<p><a href="${pdfUrl}">Скачать полное предложение PDF</a></p>`,
    ].filter(Boolean).join('\n');

    const mail = await sendEmail({
      to: lead.email,
      subject: `Предложение по поездке на Камчатку — ${proposal.headline}`,
      text: lines.join('\n'),
      html,
    });

    if (mail.success) {
      sent.push('email');
    } else {
      // Ловить можно, молчать нельзя: без причины в логе отказ почты снова
      // станет невидимым (§4.0).
      console.error('[proposal-delivery] письмо не отправлено', { leadId, error: mail.error });
      failed.push('email');
    }
  }

  // Единственная попытка была почтой, которой нет: это не сбой связи, повтор
  // не поможет — нужен звонок. Отдельная причина, отдельные слова оператору.
  const emailOnly = sent.length === 0 && failed.length === 1 && failed[0] === 'email';

  if (sent.length === 0) {
    // Ни один канал не сработал (нет chat_id и почты, либо Telegram отказал).
    // Держать при этом статус «отправлено» — соврать оператору и потерять
    // клиента: он ждёт предложения, которого никто не послал.
    await releaseClaim();
    return {
      ok: false,
      // Два разных исхода, а не один: «канал отказал» — это сбой (502, стоит
      // повторить), «адреса нет вовсе» — состояние данных (409, повтор не
      // поможет). До 11.09 оба отдавали 502 «ошибка шлюза» (#1804).
      reason: emailOnly ? 'no_recipient' : failed.length > 0 ? 'not_delivered' : 'no_recipient',
      message: emailOnly
        ? 'Письмо не ушло, а Telegram у лида нет. Статус лида не изменён — попробуйте ещё раз или позвоните клиенту: PDF-предложение можно скачать кнопкой рядом.'
        : failed.length > 0
          ? 'Не удалось доставить предложение ни одним каналом. Статус лида не изменён — попробуйте ещё раз.'
          : 'Некуда отправлять: у лида нет ни Telegram, ни почты. Статус лида не изменён.',
    };
  }

  return {
    ok: true,
    sent,
    failed,
    pdfUrl,
    // Список каналов в сообщении — только те, куда реально ушло. Если почта
    // не сработала, оператор обязан это увидеть здесь же, а не узнать от
    // клиента через неделю.
    message: failed.includes('email')
      ? 'Предложение отправлено в Telegram. Письмо на почту не ушло — при необходимости позвоните клиенту.'
      : `Предложение отправлено клиенту (${sent.join(', ')})`,
  };
}
