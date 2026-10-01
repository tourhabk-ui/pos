/**
 * lib/safety/trip-watch.ts — единственный способ поставить, продлить и снять
 * контроль выхода (docs/safety/WATCH_MANIFEST.md, правило 1).
 *
 * Все пути создания — форма /register и чат Кузьмича в MAX — пишут одну и ту
 * же строку `route_registrations` одним INSERT. Два INSERT'а в двух местах —
 * это две правды о том, какие поля у контроля обязательны, и они разойдутся
 * первой же новой колонкой.
 *
 * Сторожит этот контроль только `checkin-watchdog`; здесь — запись, продление,
 * закрытие и весть тем, кого уже встревожили.
 *
 * Дежурному — только через `alertDuty`: данные в MAX (`sendPdAlert`), в
 * Telegram — заглушка без них. Так обещает политика конфиденциальности
 * (разд. 5) и так решил владелец 23.08 (lib/notifications/pd-alert.ts).
 */
import { pool } from '@/lib/db-pool';
import { sendEmail } from '@/lib/email';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { tgSend } from '@/lib/notifications/tg-send';
import { exolveConfigured, makeExolveVoiceCall } from '@/lib/notifications/exolve';
import { telegramService } from '@/lib/notifications/telegram';
import { escapeHtml } from '@/lib/text/escape-html';
import { logText } from '@/lib/log/log-text';
import { formatKamchatkaTime, type TripKind } from '@/lib/safety/checkin-escalation';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';

export type TripWatchSource = 'form' | 'max';
/**
 * Канал к самому туристу. Только MAX: в Telegram телефоны не собираем —
 * политика конфиденциальности обещает, что персональных данных там нет, а
 * контроль без телефонов не работает (разбор юристом-критиком 30.09).
 */
export type TouristChannel = 'max';

export interface TripWatchInput {
  source: TripWatchSource;
  userId: string | null;
  routeName: string;
  routeDescription: string | null;
  startDate: string; // YYYY-MM-DD (по Камчатке)
  endDate: string;
  expectedReturnAt: Date | null;
  /** Род похода, если его знает вызывающий (чат — по длительности). Иначе — по датам. */
  tripKind?: TripKind;
  region: string;
  groupSize: number;
  groupMembers: unknown[] | null;
  leaderName: string;
  leaderPhone: string;
  leaderEmail: string | null;
  contactName: string;
  contactPhone: string;
  contactRelation: string | null;
  contactTelegramChatId: string | null;
  contactEmail: string | null;
  contactConsent: boolean;
  /** Канал к самому туристу — только у контроля из чата. */
  touristChat: { channel: TouristChannel; chatId: number } | null;
}

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export async function createTripWatch(input: TripWatchInput, db: Queryable = pool): Promise<string> {
  const tripKind = input.tripKind ?? (input.startDate === input.endDate ? 'day' : 'multi');
  const { rows } = await db.query(
    `INSERT INTO route_registrations
       (user_id, route_name, route_description, start_date, end_date, region,
        group_size, group_members, leader_name, leader_phone, leader_email,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
        emergency_contact_telegram_chat_id, emergency_contact_email,
        emergency_contact_consent, expected_return_at, trip_kind,
        source, tourist_chat_channel, tourist_chat_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id`,
    [
      input.userId,
      input.routeName,
      input.routeDescription,
      input.startDate,
      input.endDate,
      input.region,
      input.groupSize,
      input.groupMembers ? JSON.stringify(input.groupMembers) : null,
      input.leaderName,
      input.leaderPhone,
      input.leaderEmail,
      input.contactName,
      input.contactPhone,
      input.contactRelation,
      input.contactTelegramChatId,
      input.contactEmail,
      input.contactConsent,
      input.expectedReturnAt,
      tripKind,
      input.source,
      input.touristChat?.channel ?? null,
      input.touristChat?.chatId ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (typeof id !== 'string') throw new Error('route_registrations: INSERT не вернул id');
  return id;
}

export interface OpenWatch {
  id: string;
  route_name: string;
  expected_return_at: Date | null;
  emergency_contact_name: string;
  /** Старшая ступень, ушедшая после последнего продления: 0 — никого не будили. */
  last_step: number;
  /**
   * Тревога за всё время дошла до кого-то, кроме самого туриста (контакт,
   * дежурный). Только тогда «тем, кого встревожили, я сообщил» — правда:
   * весть уходит ровно им (announceToAlerted), а туристу не пишем.
   */
  alerted_others: boolean;
}

/** Открытые контроли, поставленные из этого чата (ближайший срок первым). */
export async function openWatchesForChat(channel: TouristChannel, chatId: number): Promise<OpenWatch[]> {
  const { rows } = await pool.query<OpenWatch>(
    `SELECT r.id, r.route_name, r.expected_return_at, r.emergency_contact_name,
            COALESCE((SELECT MAX(n.step) FROM route_registration_notifications n
                       WHERE n.registration_id = r.id AND n.status IN ('sent', 'skipped')
                         AND (r.ladder_reset_at IS NULL OR n.sent_at >= r.ladder_reset_at)), 0)::int AS last_step,
            EXISTS (SELECT 1 FROM route_registration_notifications n
                     WHERE n.registration_id = r.id AND n.status = 'sent' AND n.recipient <> 'tourist') AS alerted_others
       FROM route_registrations r
      WHERE r.tourist_chat_channel = $1 AND r.tourist_chat_id = $2 AND r.completed_at IS NULL
      ORDER BY r.expected_return_at ASC NULLS LAST`,
    [channel, chatId],
  );
  return rows;
}

/** Почему закрыт: вернулся или снял контроль, не сказав, что вернулся. */
export type ClosedReason = 'returned' | 'cancelled';

/**
 * Закрыть контроль. Закрывает только ОТКРЫТЫЙ контроль и говорит, закрыл ли:
 * повторное «вернулся» не должно читаться как новое закрытие. Всех, кого уже
 * встревожили, извещает (правило 10) — и называет причину: «отменил» — не
 * «вернулся, искать не нужно».
 */
export async function closeTripWatch(id: string, by: 'link' | 'chat', reason: ClosedReason): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE route_registrations
        SET completed_at = now(), closed_by = $2, closed_reason = $3, updated_at = now()
      WHERE id = $1 AND completed_at IS NULL`,
    [id, by, reason],
  );
  const closed = (rowCount ?? 0) > 0;
  if (closed) await announceClosure(id, by, reason);
  return closed;
}

/**
 * Весть о закрытии тем, кого встревожили. Отдельно от закрытия — её зовёт и
 * сторож: если турист закрыл контроль, пока шаг уже уходил, весть должна
 * догнать этот шаг (разбор противником, 30.09).
 *
 * Отбоем («искать не нужно») она становится только при «вернулся». Снятый
 * контроль и незаписанная причина — это сообщение о закрытии, а решение
 * снимать тревогу остаётся за тем, кто её получил (§4.0).
 */
export async function announceClosure(id: string, by: 'link' | 'chat', reason: ClosedReason | null): Promise<void> {
  const how = by === 'chat' ? 'в чате' : 'по ссылке';
  const at = formatKamchatkaTime(new Date());
  await announceToAlerted(id, (w) => {
    if (reason === 'returned') {
      return `Отбой тревоги: турист ${w.leader_name} вернулся с маршрута «${w.route_name}» (отметка ${how}, ${at}). Искать не нужно.`;
    }
    const what = reason === 'cancelled'
      ? `Турист ${w.leader_name} снял контроль маршрута «${w.route_name}» (${how}, ${at}), но не написал, что вернулся.`
      : `Контроль маршрута «${w.route_name}» (турист ${w.leader_name}) закрыт ${how}, ${at}; причина не записана.`;
    return `${what} Если тревога у вас — дозвонитесь до туриста, прежде чем её снимать.`;
  });
}

/**
 * «Жив, задерживаюсь»: сдвигает отсчёт тревог на эту минуту (лестница
 * не начинается заново, пройденные шаги остаются пройденными —
 * checkin-escalation.ts) и извещает тех, кого уже встревожили.
 */
export async function markTripWatchAlive(ids: string[], via: 'link' | 'chat'): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE route_registrations SET checkin_confirmed_at = now(), updated_at = now()
      WHERE id = ANY($1::uuid[]) AND completed_at IS NULL
      RETURNING id`,
    [ids],
  );
  for (const r of rows) {
    await announceToAlerted(r.id, (w) =>
      `Турист ${w.leader_name} (маршрут «${w.route_name}») на связи: отметил, что всё в порядке и задерживается ` +
      `(${via === 'chat' ? 'в чате' : 'по ссылке'}, ${formatKamchatkaTime(new Date())}). ` +
      // После ступени МЧС лестница дальше не идёт — обещать «продолжится»
      // было бы неправдой: решение теперь за дежурным.
      (w.mchs_sent
        ? 'Тревога дежурному уже ушла — решите, снимать ли её.'
        : 'Следующий шаг лестницы отложен от этой минуты.'));
  }
  return rows.length;
}

/**
 * Новый срок по слову туриста («+2 ч», «до 21:00»). Лестница начинается
 * заново — с вопроса самому туристу, — потому что сторож считает пройденными
 * только шаги после `ladder_reset_at`. Тем, кого уже встревожили, — весть.
 */
export async function extendTripWatch(id: string, newReturnAt: Date, kind: TripKind): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE route_registrations
        SET expected_return_at = $2, end_date = $3::date, trip_kind = $4,
            ladder_reset_at = now(), checkin_confirmed_at = NULL, updated_at = now()
      WHERE id = $1 AND completed_at IS NULL`,
    [id, newReturnAt, kamchatkaDate(newReturnAt), kind],
  );
  const extended = (rowCount ?? 0) > 0;
  if (extended) {
    await announceToAlerted(id, (w) =>
      `Турист ${w.leader_name} (маршрут «${w.route_name}») на связи и назначил новый срок — ` +
      `${formatKamchatkaTime(newReturnAt)}. Лестница начнётся заново от него.`);
  }
  return extended;
}

interface AlertedWatch {
  route_name: string;
  leader_name: string;
  contact_tg: string | null;
  mchs_sent: boolean;
}

/**
 * Тревога или весть дежурному: данные — в MAX (`sendPdAlert`), и ВСЕГДА
 * заглушка без данных в Telegram. `sendPdAlert` шлёт заглушку только при
 * отказе MAX, а для тревоги этого мало: дежурный может не смотреть MAX, и
 * второй канал — это не резерв на отказ, а второй шанс разбудить человека.
 *
 * `wake` — тревога, ради которой дежурного будят звонком (Exolve, номер
 * `TRIP_WATCH_DUTY_PHONE`). Ночью сообщение в мессенджере не будит, звонок —
 * будит. Робот читает ту же заглушку: номер дела и что делать, без имён и
 * телефонов — данные остаются в MAX. Звонок не делает тревогу доставленной:
 * `delivered` — по-прежнему только MAX, потому что без данных дежурному
 * нечего передать спасателям. Весть «вернулся» звонком не будит.
 */
export async function alertDuty(
  text: string,
  stub: string,
  opts: { wake?: boolean } = {},
): Promise<{ delivered: boolean; reason: string; call: DutyCall }> {
  const r = await sendPdAlert({ text: escapeHtml(text), stub: escapeHtml(stub) });
  if (r.channel === 'max') {
    const t = await tgSend('trip-watch', escapeHtml(stub));
    if (!t.ok) console.error('[trip-watch] заглушка дежурному в Telegram не ушла', logText(t.reason));
  }
  const call = opts.wake ? await callDuty(stub) : 'not_requested';
  return { delivered: r.delivered, reason: r.reason, call };
}

export type DutyCall = 'sent' | 'failed' | 'not_configured' | 'not_requested';

/**
 * Звонок дежурному. Три исхода не сводятся к двум: «не настроен» (нет ключа
 * Exolve или номера дежурного) — известное состояние до подключения канала,
 * «сбой» — громко в лог.
 */
async function callDuty(stub: string): Promise<DutyCall> {
  const phone = process.env.TRIP_WATCH_DUTY_PHONE?.trim();
  if (!phone || !exolveConfigured()) return 'not_configured';
  const c = await makeExolveVoiceCall(phone, dutyVoiceText(stub));
  if (c.status === 'failed') console.error('[trip-watch] звонок дежурному не ушёл', logText(c.reason, 200));
  return c.status;
}

/** Текст для робота: заглушка без значков, с паузами вместо разделителей. */
export function dutyVoiceText(stub: string): string {
  return `Ведар. ${stub.replace(/\s*·\s*/g, '. ')} Повторяю. ${stub.replace(/\s*·\s*/g, '. ')}`;
}

/** Заглушка для Telegram: без имён, телефонов и координат. */
export function dutyStub(id: string, what: string): string {
  return `Контроль выхода · дело ${id.slice(0, 8)} · ${what}. Данные — в рабочем чате MAX.`;
}

/**
 * Разослать весть тем, кому уже ушла тревога (журнал доставки,
 * status = 'sent'): контакту — тем же каналом, дежурному — через `alertDuty`.
 * Туристу не пишем: весть от него же. Не встревожили никого — молчим:
 * человек, которого не пугали, не должен получать «отбой».
 *
 * Отказ отправки не отменяет закрытия (человек вернулся — это факт), но
 * называется в логе: отбой, не дошедший до контакта, значит, что контакт
 * может вызвать спасателей к человеку, который уже дома.
 */
async function announceToAlerted(id: string, textFor: (w: AlertedWatch) => string): Promise<void> {
  try {
    const { rows: [w] } = await pool.query<AlertedWatch>(
      `SELECT r.route_name, r.leader_name, r.emergency_contact_telegram_chat_id::text AS contact_tg,
              EXISTS (SELECT 1 FROM route_registration_notifications n
                       WHERE n.registration_id = r.id AND n.step = 3 AND n.status = 'sent'
                         AND (r.ladder_reset_at IS NULL OR n.sent_at >= r.ladder_reset_at)) AS mchs_sent
         FROM route_registrations r WHERE r.id = $1`,
      [id],
    );
    if (!w) return;
    const { rows: sent } = await pool.query<{ channel: string; recipient: string }>(
      `SELECT DISTINCT channel, recipient FROM route_registration_notifications
        WHERE registration_id = $1 AND status = 'sent'`,
      [id],
    );
    if (sent.length === 0) return;
    const text = textFor(w);

    const toDuty = sent.some((n) => n.channel === 'admin_only' || n.recipient === 'admin');
    const toContactTg = sent.some((n) => n.channel === 'telegram' && n.recipient !== 'admin' && n.recipient !== 'tourist');
    const emails = [...new Set(sent.filter((n) => n.channel === 'email').map((n) => n.recipient))];

    if (toDuty) {
      const r = await alertDuty(text, dutyStub(id, 'весть о туристе'));
      if (!r.delivered) console.error('[trip-watch] весть дежурному не доставлена в MAX', logText(id), logText(r.reason));
    }
    if (toContactTg && w.contact_tg) {
      const r = await telegramService.sendMessage({ chatId: w.contact_tg, text: escapeHtml(text) });
      if (!r.success) console.error('[trip-watch] весть контакту в Telegram не доставлена', logText(id), logText(r.error ?? ''));
    }
    for (const to of emails) {
      const e = await sendEmail({ to, subject: 'Ведар: новости о туристе', text });
      if (!e.success) console.error('[trip-watch] письмо контакту не отправлено', logText(id), logText(e.error ?? ''));
    }
  } catch (err) {
    console.error('[trip-watch] весть встревоженным не разослана', logText(id), logText(err instanceof Error ? err.message : err));
  }
}
