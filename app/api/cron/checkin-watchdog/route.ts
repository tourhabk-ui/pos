/**
 * GET /api/cron/checkin-watchdog
 * Почасовой сторож маршрутов: эскалирует по лестнице при просрочке возврата.
 * Лестница: soft (спросить туриста) → hard (экстренный контакт) → mchs.
 */
import { NextResponse } from 'next/server';
import { sendEmail } from '@/lib/email';
import { maxSendDm } from '@/lib/notifications/max-channel';
import { escapeHtml } from '@/lib/text/escape-html';
import { telegramService } from '@/lib/notifications/telegram';
import { query } from '@/lib/database';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import {
  decideEscalation,
  resolveControlTime,
  tripKindFromDates,
  buildEscalationMessage,
  buildTouristWakeMessage,
  BUFFERS,
  formatPositionText,
  formatKamchatkaTime,
} from '@/lib/safety/checkin-escalation';
import type { EscalationStep, PositionSource } from '@/lib/safety/checkin-escalation';

export const dynamic = 'force-dynamic';

const SITE_BASE = process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru';

interface RegRow {
  id: string;
  route_name: string;
  start_date: Date;
  end_date: Date;
  expected_return_at: Date | null;
  trip_kind: 'day' | 'multi';
  checkin_confirmed_at: Date | null;
  mchs_informed_at: Date | null;
  last_position_lat: string | null;
  last_position_lng: string | null;
  last_position_source: PositionSource;
  leader_name: string;
  leader_phone: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  emergency_contact_telegram_chat_id: string | null;
  emergency_contact_email: string | null;
  source: 'form' | 'telegram' | 'max';
  tourist_chat_channel: 'tg' | 'max' | null;
  tourist_chat_id: string | null;
  sent_steps: string[];
}

type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Отправка в Telegram с ЧЕСТНЫМ исходом — общим сервисом, который читает
 * `ok` ответа (lib/notifications/telegram.ts).
 *
 * До 30.09 ответ не читался вовсе: контакт, который ни разу не писал боту,
 * получает от Telegram 403 «bot can't initiate conversation», а шаг писался как
 * `sent` — тревога числилась доставленной человеку, до которого не дошла
 * (§4.0: «не смог» выдавалось за «хорошо»). Текст экранируется: сервис шлёт в
 * HTML-режиме, и «<» в названии маршрута отверг бы сообщение целиком.
 */
async function sendTelegram(chatId: string, text: string): Promise<SendResult> {
  if (!chatId) return { ok: false, error: 'нет chat_id' };
  const r = await telegramService.sendMessage({ chatId, text: escapeHtml(text) });
  return r.success ? { ok: true } : { ok: false, error: r.error ?? 'Telegram не ответил' };
}

/**
 * Откуда контроль — строка для дежурного. Телефоны контроля из чата введены
 * самим туристом и кодом не подтверждены: дежурный, который звонит незнакомому
 * человеку ночью, должен это знать (правило 4: решение за ним).
 */
function sourceNote(reg: RegRow): string {
  if (reg.source === 'telegram' || reg.source === 'max') {
    const where = reg.source === 'telegram' ? 'Telegram' : 'MAX';
    return `Контроль поставлен из чата Кузьмича (${where}); телефоны введены туристом и кодом не подтверждены.\n`;
  }
  return 'Контроль поставлен формой /register.\n';
}

/**
 * Шаг к экстренному контакту (soft/hard).
 *
 * Контакт без Telegram или с отказом доставки раньше просто пропускался
 * (`skipped`) — лестница шла дальше, а живой человек, который мог бы позвонить
 * туристу, не узнавал ничего. Теперь такой шаг уходит в админ-чат с именем и
 * телефоном контакта: позвонить может человек, раз не смог бот.
 */
async function notifyContact(reg: RegRow, step: EscalationStep, msg: string): Promise<void> {
  const reasons: string[] = [];
  let delivered = false;

  const contactChat = reg.emergency_contact_telegram_chat_id;
  if (contactChat) {
    const r = await sendTelegram(contactChat, msg);
    if (r.ok) {
      delivered = true;
      await recordNotification(reg.id, step, 'telegram', reg.emergency_contact_phone);
    } else {
      reasons.push(`Telegram не доставлен (${r.error})`);
      await recordNotification(reg.id, step, 'telegram', reg.emergency_contact_phone, 'failed', r.error);
    }
  } else {
    reasons.push('у контакта нет Telegram');
  }

  // Почта — второй канал к контакту. Перенесена сюда 30.09 из снятого
  // route-escalation: это была единственная полезная часть второго сторожа.
  const email = reg.emergency_contact_email?.trim();
  if (email) {
    const e = await sendEmail({ to: email, subject: `Ведар: ${reg.leader_name} не вернулся к сроку`, text: msg });
    if (e.success) {
      delivered = true;
      await recordNotification(reg.id, step, 'email', email);
    } else {
      reasons.push(`письмо не отправлено (${e.error ?? 'нет причины'})`);
      await recordNotification(reg.id, step, 'email', email, 'failed', e.error);
    }
  }

  if (delivered) return;

  const reason = reasons.join('; ');
  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  const adminText =
    `ПОЗВОНИТЕ КОНТАКТУ — ${reason}\n` +
    `${reg.emergency_contact_name}: ${reg.emergency_contact_phone}\n` +
    sourceNote(reg) + `\n${msg}`;
  const a = adminChatId ? await sendTelegram(adminChatId, adminText) : { ok: false as const, error: 'TELEGRAM_CHAT_ID не задан' };
  if (a.ok) {
    await recordNotification(reg.id, step, 'admin_only', 'admin');
  } else {
    // Не дошло никуда — это громко в лог и `skipped`, чтобы лестница не встала:
    // следующая ступень (в итоге МЧС-тревога) важнее повторов этой.
    console.error('[checkin-watchdog] шаг не доставлен никому', { registrationId: reg.id, step, reason, admin: a.error });
    await recordNotification(reg.id, step, 'none', reg.emergency_contact_phone, 'skipped', `${reason}; админ: ${a.error}`);
  }
}

/**
 * Первая ступень — туристу в его чат (Telegram или MAX), если контроль
 * поставлен из чата. true — канал подтвердил доставку.
 */
async function wakeTourist(reg: RegRow, controlTime: Date, tripKind: 'day' | 'multi'): Promise<boolean> {
  const b = BUFFERS[tripKind];
  const text = buildTouristWakeMessage({
    routeName: reg.route_name,
    controlTime,
    contactName: reg.emergency_contact_name,
    hoursUntilContact: b.hard - b.soft,
    // Своего канала к контакту у контроля из чата нет (до SMS): следующую
    // ступень несёт дежурный звонком — так и сказано туристу.
    contactByDuty: !reg.emergency_contact_telegram_chat_id && !reg.emergency_contact_email,
  });
  const chatId = reg.tourist_chat_id ?? '';
  const r: SendResult = reg.tourist_chat_channel === 'max'
    ? await maxSendDm(chatId, escapeHtml(text)).then((x) => (x.ok ? { ok: true as const } : { ok: false as const, error: x.error ?? 'MAX не ответил' }))
    : await sendTelegram(chatId, text);
  const channel = reg.tourist_chat_channel === 'max' ? 'max' : 'telegram';
  if (r.ok) {
    await recordNotification(reg.id, 'soft', channel, 'tourist');
    return true;
  }
  await recordNotification(reg.id, 'soft', channel, 'tourist', 'failed', r.error);
  return false;
}

async function recordNotification(
  registrationId: string,
  step: EscalationStep,
  channel: string,
  recipient: string,
  status: 'sent' | 'skipped' | 'failed' = 'sent',
  error?: string,
): Promise<void> {
  await query(
    `INSERT INTO route_registration_notifications
       (registration_id, step, channel, recipient, status, error_message, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [registrationId, stepToNum(step), channel, recipient, status, error ?? null],
  );
}

function stepToNum(step: EscalationStep): number {
  return step === 'soft' ? 1 : step === 'hard' ? 2 : 3;
}

function buildMessage(
  reg: RegRow,
  step: EscalationStep,
  hoursOverdue: number,
  hoursSinceConfirm: number | null,
): string {
  return buildEscalationMessage(
    {
      routeName: reg.route_name,
      leaderName: reg.leader_name,
      leaderPhone: reg.leader_phone,
      emergencyContactName: reg.emergency_contact_name,
      emergencyContactPhone: reg.emergency_contact_phone,
      positionText: formatPositionText(
        reg.last_position_lat,
        reg.last_position_lng,
        reg.last_position_source,
      ),
      returnUrl: `${SITE_BASE}/return?id=${reg.id}`,
      // Вторая ссылка — для живой группы, которая просто задерживается. Без
      // неё единственным способом снять тревогу была отметка о ВОЗВРАТЕ, то
      // есть ложь, выключающая сторожа.
      checkinUrl: `${SITE_BASE}/checkin-ok?id=${reg.id}`,
      hoursSinceConfirm,
      mchsInformedText: reg.mchs_informed_at ? formatKamchatkaTime(new Date(reg.mchs_informed_at)) : null,
    },
    step,
    hoursOverdue,
  );
}

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !timingSafeCompare(secret ?? '', cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  const lease = await claimCronWindow('checkin-watchdog', 60, 'external');
  if (!shouldRun(lease)) return NextResponse.json(leaseSkipBody('checkin-watchdog', 60));

  const now = new Date();
  const startedAt = Date.now();

  // Регистрации без отметки о возвращении с ожидаемым временем в прошлом (или дата уже прошла)
  const { rows } = await query<RegRow>(`
    SELECT
      r.id,
      r.route_name,
      r.start_date,
      r.end_date,
      r.expected_return_at,
      COALESCE(r.trip_kind, 'day') AS trip_kind,
      r.checkin_confirmed_at,
      r.mchs_informed_at,
      r.last_position_lat::text,
      r.last_position_lng::text,
      r.last_position_source,
      r.leader_name,
      r.leader_phone,
      r.emergency_contact_name,
      r.emergency_contact_phone,
      r.emergency_contact_telegram_chat_id::text,
      r.emergency_contact_email,
      r.source,
      r.tourist_chat_channel,
      r.tourist_chat_id::text,
      COALESCE(
        ARRAY(
          SELECT CASE n.step
            WHEN 1 THEN 'soft' WHEN 2 THEN 'hard' ELSE 'mchs'
          END
          FROM route_registration_notifications n
          WHERE n.registration_id = r.id AND n.status IN ('sent', 'skipped')
          ORDER BY n.step
        ),
        ARRAY[]::text[]
      ) AS sent_steps
    FROM route_registrations r
    WHERE r.completed_at IS NULL
      AND (
        r.expected_return_at IS NOT NULL AND r.expected_return_at < $1
        OR
        r.expected_return_at IS NULL AND r.end_date < $2
      )
    ORDER BY COALESCE(r.expected_return_at, r.end_date::timestamptz) ASC
    LIMIT 100
  `, [now, now]);

  let processed = 0;
  let escalated = 0;

  /**
   * Сколько туристов не удалось обработать. Не «ошибки» вообще, а именно
   * пропущенные ЛЮДИ: цифра идёт в ответ и в журнал прогонов.
   */
  let failed = 0;

  for (const reg of rows) {
    processed++;
   try {

    const tripKind = reg.trip_kind ?? tripKindFromDates(new Date(reg.start_date), new Date(reg.end_date));
    const controlTime = resolveControlTime(reg.end_date, reg.expected_return_at ? new Date(reg.expected_return_at) : null);
    const alreadySent = (reg.sent_steps ?? []) as EscalationStep[];
    const confirmedAt = reg.checkin_confirmed_at ? new Date(reg.checkin_confirmed_at) : null;

    const decision = decideEscalation(controlTime, tripKind, alreadySent, confirmedAt, now);
    if (!decision) continue;

    const { step, hoursOverdue, hoursSinceConfirm } = decision;
    const msg = buildMessage(reg, step, hoursOverdue, hoursSinceConfirm);

    // Уведомление в зависимости от шага.
    // Важно: recordNotification вызывается ВСЕГДА — иначе шаг не записывается
    // и эскалация стоит на месте при отсутствии Telegram.
    if (step === 'soft' && reg.tourist_chat_channel && reg.tourist_chat_id) {
      // Сначала сам человек (манифест, правило 4). Не дошло — контакту сразу.
      const woke = await wakeTourist(reg, controlTime, tripKind);
      if (!woke) await notifyContact(reg, step, msg);
    } else if (step === 'soft' || step === 'hard') {
      await notifyContact(reg, step, msg);
    } else {
      // mchs — уведомляем admin-чат для ручной передачи в МЧС
      const adminChatId = process.env.TELEGRAM_CHAT_ID;
      const r = adminChatId
        ? await sendTelegram(adminChatId, `МЧС-ТРЕВОГА\n${sourceNote(reg)}\n${msg}`)
        : { ok: false as const, error: 'TELEGRAM_CHAT_ID не задан' };
      if (r.ok) {
        await recordNotification(reg.id, step, 'telegram', 'admin');
      } else {
        // МЧС-тревога, не дошедшая до человека, — самый тяжёлый отказ крона:
        // не `skipped` (тогда следующий прогон её не повторит), а `failed`,
        // и прогон краснеет (failed++ ниже через throw).
        await recordNotification(reg.id, step, 'none', 'admin', 'failed', r.error);
        throw new Error(`МЧС-тревога не доставлена: ${r.error}`);
      }
    }

    escalated++;
    } catch (err) {
      /**
       * Сбой на ОДНОМ туристе не отменяет остальных.
       *
       * До этого тело цикла не было защищено вовсе: любое исключение —
       * отправка в Telegram, запись уведомления, недоступная база — роняло
       * весь обработчик. А выборка идёт `ORDER BY expected_return_at ASC`,
       * то есть первым обрабатывается САМЫЙ просроченный. Один сбойный
       * человек хоронил очередь тех, кто за ним, и делал это молча: до
       * recordCronRun выполнение не доходило, и крон выглядел не упавшим,
       * а не запускавшимся.
       *
       * Для сторожа, который эскалирует невернувшихся туристов до МЧС, это
       * худший из возможных отказов.
       */
      failed++;
      console.error('[checkin-watchdog] турист не обработан', {
        registrationId: reg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Черновики контроля, брошенные на полпути, держат телефоны людей, которые
  // ни на что не соглашались (правило 9). Живёт черновик 30 минут; сутки —
  // с запасом. Сбой уборки не мешает тревогам: лог, и дальше.
  try {
    await query(`DELETE FROM trip_watch_flow WHERE updated_at < now() - interval '1 day'`);
  } catch (err) {
    console.error('[checkin-watchdog] уборка черновиков не выполнилась', err instanceof Error ? err.message : err);
  }

  // Пропущенные люди — это НЕ успех. Прогон, где кого-то не обработали,
  // помечается failed: иначе сторож ляжет наполовину, а реестр кронов будет
  // показывать здоровье.
  recordCronRun(
    'checkin-watchdog',
    startedAt,
    failed > 0 ? 'failed' : 'success',
    { items: processed, ...(failed > 0 ? { error: `не обработано туристов: ${failed}` } : {}) },
  );
  return NextResponse.json({ success: failed === 0, processed, escalated, failed, ts: now.toISOString() });
}
