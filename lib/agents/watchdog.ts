/**
 * lib/agents/watchdog.ts
 *
 * Watchdog — реальный мониторинг платформы.
 * Запускается каждые 30 мин через /api/cron/watchdog.
 *
 * Проверяет:
 *   1. Бронирования без подтверждения > 24ч
 *   2. Операторы без ответа > 48ч
 *   3. Лиды без обработки > 2ч
 *   4. SOS-сигналы без реакции > 30 мин
 *   5. Сейсмо-крон (safety-ingest) мёртв > 15 мин
 *   6. Любой safety-крон из реестра мёртв (liveness по cron-registry)
 *
 * Все алерты → Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
 */

import { pool } from '@/lib/db-pool';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { getPublicBaseUrl } from '@/lib/config';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { computeLiveness } from '@/lib/agents/cron-liveness';

export interface WatchdogAlert {
  type: 'unconfirmed_booking' | 'operator_no_response' | 'unprocessed_lead' | 'sos_ignored' | 'seismic_cron_dead' | 'unconfirmed_stay_booking' | 'safety_cron_dead' | 'pending_gear_rental' | 'pending_transfer_booking';
  count: number;
  details: string;
}

export interface WatchdogResult {
  alerts: WatchdogAlert[];
  checked_at: string;
  duration_ms: number;
}

async function tgSend(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // Silent fail
  }
}

async function checkUnconfirmedBookings(): Promise<WatchdogAlert | null> {
  try {
    const { rows } = await pool.query<{ count: string; oldest_hours: string }>(`
      SELECT
        COUNT(*)::text          AS count,
        MAX(EXTRACT(EPOCH FROM (NOW() - created_at))/3600)::text AS oldest_hours
      FROM operator_bookings
      WHERE booking_status = 'new'
        AND created_at < NOW() - INTERVAL '24 hours'
        AND deleted_at IS NULL
    `);
    const count = parseInt(rows[0]?.count ?? '0', 10);
    if (count === 0) return null;
    const hours = Math.round(parseFloat(rows[0]?.oldest_hours ?? '24'));
    return {
      type: 'unconfirmed_booking',
      count,
      details: `${count} бронирований без подтверждения. Старейшее — ${hours}ч назад.`,
    };
  } catch {
    return null;
  }
}

async function notifyOperatorDirectly(
  chatId: string,
  partnerName: string,
  count: number,
  oldest: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  const appUrl = getPublicBaseUrl();
  const text = [
    `<b>Привет, ${partnerName}!</b>`,
    '',
    `У тебя ${count} ${count === 1 ? 'бронирование ожидает' : 'бронирований ожидают'} ответа уже больше 48 часов.`,
    `Самое раннее — ${oldest}.`,
    '',
    `Посмотри и подтверди или отклони: <a href="${appUrl}/hub/operator/bookings">Мои бронирования</a>`,
  ].join('\n');
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* не блокируем */ }
}

async function checkOperatorNoResponse(): Promise<WatchdogAlert | null> {
  try {
    const { rows } = await pool.query<{
      operator_id: string;
      partner_slug: string | null;
      partner_name: string | null;
      telegram_chat_id: string | null;
      count: string;
      oldest: string;
    }>(
      `SELECT ot.operator_id::text,
              p.slug AS partner_slug,
              COALESCE(p.company_name, p.name) AS partner_name,
              p.telegram_chat_id,
              COUNT(*)::text AS count,
              MIN(ob.created_at)::date::text AS oldest
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       LEFT JOIN partners p ON p.id = ot.operator_id
       WHERE ob.booking_status = 'new'
         AND ob.created_at < NOW() - INTERVAL '48 hours'
         AND ob.deleted_at IS NULL
       GROUP BY ot.operator_id, p.slug, p.company_name, p.name, p.telegram_chat_id`,
    );
    if (rows.length === 0) return null;

    const dateStr = new Date().toISOString().slice(0, 10);
    for (const row of rows) {
      // Пишем паттерн в Brain
      const slug = `patterns/operators/${row.partner_slug ?? row.operator_id}`;
      const entry = `${dateStr}: ${row.count} бронирований без ответа >48ч`;
      knowledgeBase.upsert({
        slug,
        type: 'pattern',
        title: `Паттерн оператора: ${row.partner_slug ?? row.operator_id}`,
        compiled_truth: entry,
        metadata: { last_checked: dateStr, pending_count: Number(row.count) },
        agent_id: 'watchdog',
      }).then(() => knowledgeBase.appendTimeline(slug, entry)).catch(() => {});

      // Пишем оператору напрямую если зарегистрирован
      if (row.telegram_chat_id && row.partner_name) {
        notifyOperatorDirectly(
          row.telegram_chat_id,
          row.partner_name,
          parseInt(row.count, 10),
          row.oldest,
        ).catch(() => {});
      }
    }

    const notified = rows.filter(r => r.telegram_chat_id).length;
    return {
      type: 'operator_no_response',
      count: rows.length,
      details: `${rows.length} оператор(ов) не ответили на бронирование > 48ч.${notified > 0 ? ` Уведомлено напрямую: ${notified}.` : ' Операторы не подключены к боту.'}`,
    };
  } catch {
    return null;
  }
}

async function notifyStayOwnerDirectly(
  chatId: string,
  ownerName: string,
  count: number,
  oldest: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  const appUrl = getPublicBaseUrl();
  const text = [
    `<b>Привет, ${ownerName}!</b>`,
    '',
    `У тебя ${count} ${count === 1 ? 'бронь жилья ожидает' : 'броней жилья ожидают'} подтверждения уже больше 24 часов.`,
    `Самая ранняя — ${oldest}.`,
    '',
    `Подтверди или отклони: <a href="${appUrl}/hub/stay/bookings">Брони жилья</a>`,
  ].join('\n');
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* не блокируем */ }
}

async function checkUnconfirmedStayBookings(): Promise<WatchdogAlert | null> {
  try {
    const { rows } = await pool.query<{
      partner_id: string | null;
      owner_name: string | null;
      telegram_chat_id: string | null;
      count: string;
      oldest: string;
    }>(
      `SELECT a.partner_id::text,
              COALESCE(p.company_name, p.name) AS owner_name,
              p.telegram_chat_id,
              COUNT(*)::text AS count,
              MIN(b.created_at)::date::text AS oldest
       FROM accommodation_bookings b
       JOIN accommodations a ON a.id = b.accommodation_id
       LEFT JOIN partners p ON p.id = a.partner_id
       WHERE b.status = 'pending'
         AND b.created_at < NOW() - INTERVAL '24 hours'
       GROUP BY a.partner_id, p.company_name, p.name, p.telegram_chat_id`,
    );
    if (rows.length === 0) return null;

    let total = 0;
    for (const row of rows) {
      total += parseInt(row.count, 10) || 0;
      if (row.telegram_chat_id && row.owner_name) {
        notifyStayOwnerDirectly(
          row.telegram_chat_id,
          row.owner_name,
          parseInt(row.count, 10),
          row.oldest,
        ).catch(() => {});
      }
    }

    const notified = rows.filter(r => r.telegram_chat_id).length;
    return {
      type: 'unconfirmed_stay_booking',
      count: total,
      details: `${total} бронь(и) жилья без подтверждения > 24ч у ${rows.length} владельц(ев).${notified > 0 ? ` Уведомлено напрямую: ${notified}.` : ' Владельцы не подключены к боту.'}`,
    };
  } catch {
    return null;
  }
}

async function notifyGearPartnerDirectly(
  chatId: string,
  partnerName: string,
  count: number,
  oldest: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  const appUrl = getPublicBaseUrl();
  const text = [
    `<b>Привет, ${partnerName}!</b>`,
    '',
    `${count} заявк(и) на аренду снаряжения ждут подтверждения уже больше суток (самая ранняя — ${oldest}).`,
    '',
    `Подтверди или отклони: <a href="${appUrl}/hub/gear/rentals">Аренды</a>`,
  ].join('\n');
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* не блокируем */ }
}

async function checkPendingGearRentals(): Promise<WatchdogAlert | null> {
  try {
    // Симметрия с турами и жильём: заявка на аренду снаряжения без реакции
    // проката > 24ч. До этого gear был слепым пятном сторожа — заявка могла
    // висеть в pending неделями, и никто об этом не узнавал.
    const { rows } = await pool.query<{
      partner_name: string | null;
      telegram_chat_id: string | null;
      count: string;
      oldest: string;
    }>(
      `SELECT COALESCE(p.company_name, p.name) AS partner_name,
              p.telegram_chat_id,
              COUNT(*)::text AS count,
              MIN(gr.created_at)::date::text AS oldest
       FROM gear_rentals gr
       JOIN gear_items gi ON gi.id = gr.gear_id
       LEFT JOIN partners p ON p.id = gi.partner_id
       WHERE gr.status = 'pending'
         AND gr.created_at < NOW() - INTERVAL '24 hours'
       GROUP BY p.company_name, p.name, p.telegram_chat_id`,
    );
    if (rows.length === 0) return null;

    let total = 0;
    for (const row of rows) {
      total += parseInt(row.count, 10) || 0;
      if (row.telegram_chat_id && row.partner_name) {
        notifyGearPartnerDirectly(
          row.telegram_chat_id,
          row.partner_name,
          parseInt(row.count, 10),
          row.oldest,
        ).catch(() => {});
      }
    }

    return {
      type: 'pending_gear_rental',
      count: total,
      details: `${total} заявк(и) на аренду снаряжения без подтверждения > 24ч у ${rows.length} прокат(ов).`,
    };
  } catch {
    return null;
  }
}

async function checkPendingTransferBookings(): Promise<WatchdogAlert | null> {
  try {
    // Замыкает симметрию сторожа: туры, жильё и снаряжение уже под
    // >24ч-проверкой, брони трансферов оставались слепым пятном.
    // operator_id в transfer_bookings ссылается на operators (транспортная
    // подсистема), у которых нет telegram_chat_id — чат берём из partners
    // по совпадению email (LATERAL с LIMIT 1, чтобы дубли email не
    // размножали группы).
    const { rows } = await pool.query<{
      operator_name: string | null;
      telegram_chat_id: string | null;
      count: string;
      oldest: string;
    }>(
      `SELECT COALESCE(o.name, 'Оператор не привязан') AS operator_name,
              p.telegram_chat_id,
              COUNT(*)::text AS count,
              MIN(tb.created_at)::date::text AS oldest
       FROM transfer_bookings tb
       LEFT JOIN operators o ON o.id = tb.operator_id
       LEFT JOIN LATERAL (
         SELECT telegram_chat_id FROM partners
         WHERE LOWER(email) = LOWER(o.email)
           AND telegram_chat_id IS NOT NULL
         LIMIT 1
       ) p ON true
       WHERE tb.status = 'pending'
         AND tb.created_at < NOW() - INTERVAL '24 hours'
       GROUP BY o.name, p.telegram_chat_id`,
    );
    if (rows.length === 0) return null;

    let total = 0;
    for (const row of rows) {
      total += parseInt(row.count, 10) || 0;
      if (row.telegram_chat_id && row.operator_name) {
        notifyTransferOperatorDirectly(
          row.telegram_chat_id,
          row.operator_name,
          parseInt(row.count, 10),
          row.oldest,
        ).catch(() => {});
      }
    }

    return {
      type: 'pending_transfer_booking',
      count: total,
      details: `${total} бронь(и) трансфера без подтверждения > 24ч у ${rows.length} оператор(ов).`,
    };
  } catch {
    return null;
  }
}

async function notifyTransferOperatorDirectly(
  chatId: string,
  operatorName: string,
  count: number,
  oldest: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  const appUrl = getPublicBaseUrl();
  const text = [
    `<b>Привет, ${operatorName}!</b>`,
    '',
    `${count} бронь(и) трансфера ждут подтверждения уже больше суток (самая ранняя — ${oldest}).`,
    '',
    `Подтверди или отклони: <a href="${appUrl}/hub/transfer-operator/bookings">Брони</a>`,
  ].join('\n');
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* не блокируем */ }
}

async function checkUnprocessedLeads(): Promise<WatchdogAlert | null> {
  try {
    const { rows } = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM leads
      WHERE status = 'new'
        AND created_at < NOW() - INTERVAL '2 hours'
    `);
    const count = parseInt(rows[0]?.count ?? '0', 10);
    if (count === 0) return null;
    return {
      type: 'unprocessed_lead',
      count,
      details: `${count} новых лидов ожидают обработки > 2ч.`,
    };
  } catch {
    return null;
  }
}

async function checkIgnoredSOS(): Promise<WatchdogAlert | null> {
  try {
    // Единственный сторож SOS-таймаутов (EVO-3: Rescue-дубль убран). Порог 15 мин
    // вместо прежних 30: Watchdog бежит каждые 30 мин, при 15-мин пороге
    // непокрытый SOS ловится на следующем прогоне (~15-45 мин), а не 30-60.
    // Координаты старейшего и «112» — из бывшего Rescue, чтобы деталь не потерять.
    const { rows } = await pool.query<{
      id: number; lat: number | null; lng: number | null;
      age_min: number; total: string;
    }>(`
      SELECT id, lat, lng,
             ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60)::int AS age_min,
             COUNT(*) OVER ()::text AS total
      FROM sos_events
      WHERE status NOT IN ('resolved', 'false_alarm')
        AND created_at < NOW() - INTERVAL '15 minutes'
      ORDER BY created_at ASC
      LIMIT 1
    `);
    if (rows.length === 0) return null;
    const oldest = rows[0];
    const count = parseInt(oldest.total ?? '1', 10);
    const coords = oldest.lat != null && oldest.lng != null
      ? `${oldest.lat}, ${oldest.lng}`
      : 'координаты не переданы';
    return {
      type: 'sos_ignored',
      count,
      details: `ВНИМАНИЕ: ${count} активных SOS без реакции >15 мин. Старейший SOS #${oldest.id} — ${oldest.age_min} мин, координаты: ${coords}. Вызвать МЧС: 112.`,
    };
  } catch (err) {
    // SOS-чек не имеет права падать молча: сломанный запрос здесь уже прятал
    // мёртвый алерт месяцами (FROM sos_signals — таблицы не существует)
    console.error('[watchdog] checkIgnoredSOS failed:', err);
    return null;
  }
}

async function checkSeismicCronDead(): Promise<WatchdogAlert | null> {
  // safety-ingest cron — самый критичный. Молчание >15 мин = система слепа к землетрясениям.
  try {
    const { rows } = await pool.query<{ last_seen: string | null }>(`
      SELECT MAX(ended_at)::text AS last_seen
      FROM agent_run_history
      WHERE agent_id = 'safety-ingest'
        AND ended_at > NOW() - INTERVAL '2 hours'
    `);
    const lastSeen = rows[0]?.last_seen;
    if (!lastSeen) {
      return {
        type: 'seismic_cron_dead',
        count: 1,
        details: 'КРИТИЧНО: Сейсмо-мониторинг не запускался >2ч. Система слепа к землетрясениям и цунами.',
      };
    }
    const silenceMin = Math.round((Date.now() - new Date(lastSeen).getTime()) / 60000);
    if (silenceMin > 15) {
      // Запуски успешны, но GitHub Actions задерживает scheduled-cron (*/5) до 60-95 мин под нагрузкой —
      // это не биллинг. Durable-фикс: внешний планировщик cron-job.org дёргает endpoint точно по расписанию.
      const cause = silenceMin > 120
        ? 'cron не запускался >2ч — проверь GitHub Actions/CRON_SECRET'
        : 'GitHub Actions задерживает scheduled-cron; durable-фикс — cron-job.org каждые 5 мин на /api/cron/safety-ingest';
      return {
        type: 'seismic_cron_dead',
        count: silenceMin,
        details: `КРИТИЧНО: Сейсмо-мониторинг молчит ${silenceMin} мин (норма ≤5 мин). ${cause}.`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Любой safety-крон из реестра, который тихо встал. Обобщение checkSeismicCronDead
 * на весь safety-tier: liveness по cron-registry × agent_run_history. Алерт только
 * на 'dead' (был жив, перестал) — не на 'never' (ещё ни разу не отметился после
 * инструментирования, ложную тревогу не поднимаем). Исключены:
 *  - safety-ingest — у него отдельный, более строгий checkSeismicCronDead;
 *  - watchdog (сам себя) — рапорт «Watchdog молчит» из работающего Watchdog
 *    логически противоречив: раз проверка идёт, сторож жив. Свою живость сторож
 *    сам подтвердить не может; это дело внешнего мониторинга.
 * Порог тревоги поднят до GITHUB_DELAY_FLOOR: scheduled-cron в GitHub Actions
 * штатно задерживается до ~95 мин, и жёсткий dead-порог (для 30-мин крона ~85
 * мин) давал ложные КРИТ на каждой такой задержке.
 */
const GITHUB_DELAY_FLOOR_MIN = 150;

async function checkDeadSafetyCrons(): Promise<WatchdogAlert | null> {
  try {
    const entries = CRON_REGISTRY.filter(
      e => e.tier === 'safety' && e.agentId !== null
        && e.agentId !== 'safety-ingest' && e.agentId !== 'watchdog',
    );
    const ids = entries.map(e => e.agentId as string);
    if (ids.length === 0) return null;

    const { rows } = await pool.query<{ agent_id: string; last_seen: string | null }>(
      `SELECT agent_id, MAX(ended_at)::text AS last_seen
         FROM agent_run_history
        WHERE agent_id = ANY($1)
        GROUP BY agent_id`,
      [ids],
    );
    const lastById = new Map(rows.map(r => [r.agent_id, r.last_seen]));

    const now = Date.now();
    const dead: string[] = [];
    for (const e of entries) {
      const last = lastById.get(e.agentId as string) ?? null;
      const lastMs = last ? new Date(last).getTime() : null;
      const lv = computeLiveness(e, lastMs, now);
      // 'dead' по liveness И сверх floor задержки GitHub Actions — иначе штатная
      // задержка scheduled-cron поднимала ложный КРИТ.
      if (lv.status === 'dead' && (lv.minutesSince ?? 0) >= GITHUB_DELAY_FLOOR_MIN) {
        const mins = lv.minutesSince ?? 0;
        const ago = mins > 120 ? `${Math.round(mins / 60)}ч` : `${mins} мин`;
        dead.push(`${e.label} молчит ${ago} (норма: ${e.schedule})`);
      }
    }
    if (dead.length === 0) return null;

    return {
      type: 'safety_cron_dead',
      count: dead.length,
      details: `КРИТИЧНО: safety-агент(ы) не отвечают — ${dead.join('; ')}.`,
    };
  } catch (err) {
    console.error('[watchdog] checkDeadSafetyCrons failed:', err);
    return null;
  }
}

export async function runWatchdog(): Promise<WatchdogResult> {
  const start = Date.now();

  const [bookings, stayBookings, gearRentals, transferBookings, operators, leads, sos, seismic, safetyCrons] = await Promise.all([
    checkUnconfirmedBookings(),
    checkUnconfirmedStayBookings(),
    checkPendingGearRentals(),
    checkPendingTransferBookings(),
    checkOperatorNoResponse(),
    checkUnprocessedLeads(),
    checkIgnoredSOS(),
    checkSeismicCronDead(),
    checkDeadSafetyCrons(),
  ]);

  const alerts = [bookings, stayBookings, gearRentals, transferBookings, operators, leads, sos, seismic, safetyCrons].filter(Boolean) as WatchdogAlert[];

  if (alerts.length > 0) {
    const lines: string[] = ['<b>Watchdog — требует внимания</b>', ''];
    for (const a of alerts) {
      const prefix = a.type === 'seismic_cron_dead' || a.type === 'sos_ignored' || a.type === 'safety_cron_dead' ? 'КРИТ:' : 'ВНИМАНИЕ:';
      lines.push(`${prefix} ${a.details}`);
    }
    const adminUrl = getPublicBaseUrl();
    lines.push('', `<a href="${adminUrl}/hub/admin">Открыть панель</a>`);
    await tgSend(lines.join('\n'));
  }

  return {
    alerts,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - start,
  };
}
