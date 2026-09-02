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
 *   7. Крон работает вхолостую — запускается, отчитывается успехом, не делает
 *      работы (cron-idle)
 *   8. Крон падает подряд — запускается и каждый раз отчитывается отказом
 *      (cron-failing). Между 6 и 7 была щель: liveness считает упавший прогон
 *      отметкой о жизни, а сторож холостых смотрит только успешные прогоны и
 *      постоянно падающего не видит вовсе.
 *
 * Все алерты → Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
 */

import { pool } from '@/lib/db-pool';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { getPublicBaseUrl } from '@/lib/config';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { detectRegistrationSpike } from '@/lib/agents/agencies/operator-agency';
import { computeLiveness } from '@/lib/agents/cron-liveness';
import { blameSilentCrons, describeBlame, type CronWitness, type CronBlame } from '@/lib/agents/cron-blame';
import { findIdleCrons, formatIdleCrons, IDLE_RUNS_THRESHOLD, type CronRunRow } from '@/lib/agents/cron-idle';
import { findFailingCrons, formatFailingCrons, FAILING_RUNS_THRESHOLD, type CronStatusRow } from '@/lib/agents/cron-failing';
import { findFruitlessCrons, formatFruitlessCrons, FRUITLESS_RUNS_THRESHOLD, type CronOutcomeRow } from '@/lib/agents/cron-fruitless';
import { findUnappliedMigrations, formatUnappliedMigrations } from '@/lib/agents/migration-status';
import { readdirSync } from 'fs';
import { join } from 'path';

export interface WatchdogAlert {
  type: 'unconfirmed_booking' | 'operator_no_response' | 'unprocessed_lead' | 'sos_ignored' | 'seismic_cron_dead' | 'unconfirmed_stay_booking' | 'safety_cron_dead' | 'pending_gear_rental' | 'pending_transfer_booking' | 'push_undelivered' | 'cron_idle' | 'cron_failing' | 'migration_unapplied' | 'migration_failed' | 'operator_registration_spike' | 'payout_release_stuck' | 'cron_fruitless';
  count: number;
  details: string;
  /**
   * Явная критичность там, где её не вывести из типа. У холостых кронов вес
   * зависит от того, кто именно встал: слепой слой вулканов — КРИТ, трое суток
   * без сигналов разведки — внимание. Ровнять их одной меткой значит либо
   * недооценить первое, либо приучить пролистывать второе.
   */
  critical?: boolean;
}

/**
 * Проверка не смогла выполниться. Третий исход, отличный от null.
 *
 * До 31.08 исходов у проверки было два: тревога либо `null`. А `null` значил
 * СРАЗУ ДВЕ вещи — «проверил, нарушений нет» и «не смог проверить». Отличие
 * жило только в `console.error`, то есть в логе контейнера, который никто не
 * читает по расписанию. Отсюда состояние, ради предотвращения которого сторож
 * и существует: при недоступной БД все 18 проверок падали, `alerts` выходил
 * пустым, Telegram молчал, а прогон записывался в историю как `success`.
 *
 * §4.0: «у проверки три исхода, не два: „хорошо“, „плохо“, „не смог
 * проверить“. Третий не равен первому».
 */
export interface CheckFailure {
  readonly kind: 'check_failed';
  check: string;
  reason: string;
}

/** Результат одной проверки: тревога, чистая проверка (null) или отказ. */
type CheckResult = WatchdogAlert | CheckFailure | null;

/**
 * Отказ проверки как значение. Запись в лог НЕ делается здесь намеренно:
 * `console.error` остаётся в теле каждой проверки, где уже стоит и где его
 * держит сторож `watchdog-checks-wired` («ни одна проверка не глушит отказ»).
 * Довод того сторожа сильнее удобства: логирование, спрятанное в помощника,
 * легко потерять при следующей правке, а имя проверки рядом с её же ошибкой
 * читается без прыжка по файлу.
 */
function checkFailure(check: string, err: unknown): CheckFailure {
  return { kind: 'check_failed', check, reason: err instanceof Error ? err.message : String(err) };
}

function isCheckFailure(v: CheckResult): v is CheckFailure {
  return v !== null && 'kind' in v && v.kind === 'check_failed';
}

/**
 * Судьба тревоги — три исхода, а не «ушло/не знаем».
 *
 * `nothing_to_send` (тревог не было) и `delivered` (ушло) — разные факты, и
 * ни один из них не равен `failed`. До 30.08 различить их было нечем:
 * `tgSend` возвращал void, и недоставка выглядела как отсутствие нарушений.
 */
export type WatchdogDelivery =
  | { status: 'nothing_to_send' }
  | { status: 'delivered' }
  | { status: 'failed'; reason: string };

/**
 * Перепись прогона: сколько проверок выполнилось, сколько не смогло.
 *
 * Без неё пустой `alerts` означал сразу и «нарушений нет», и «ничего не
 * проверилось». Теперь эти два состояния различает `failed`.
 */
export interface WatchdogChecks {
  total: number;
  /** Проверки, не сумевшие выполниться, поимённо и с причиной. */
  failed: Array<{ check: string; reason: string }>;
}

export interface WatchdogResult {
  alerts: WatchdogAlert[];
  checked_at: string;
  duration_ms: number;
  /** Дошла ли собранная тревога до владельца. Пишется в agent_run_history. */
  delivery: WatchdogDelivery;
  /** Сколько проверок отработало и какие отказали. Пишется туда же. */
  checks: WatchdogChecks;
}

/**
 * Отправка тревоги. Возвращает исход, а не void.
 *
 * До 30.08 здесь стоял `catch { // Silent fail }`, и ответ Telegram не
 * читался вовсе. Тревога могла собраться и не уйти — без строки в логе, без
 * отметки в результате, при зелёном прогоне. Сторож без исправного рупора
 * неотличим от сторожа, которому не о чем доложить, и это худший вид тишины
 * в контуре, где висят SOS и мёртвый сейсмо-приём.
 *
 * Отказ по-прежнему НЕ бросает исключение (крон не должен падать из-за
 * Telegram), но теперь он назван: в логе и в `WatchdogResult.delivery`.
 */
type TgSendOutcome = { ok: true } | { ok: false; reason: string };

async function tgSend(text: string): Promise<TgSendOutcome> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    // Раньше здесь стоял голый `return`: ненастроенный канал выглядел как
    // отсутствие тревог. Молчание по этой причине — тоже недоставка.
    const reason = 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы';
    console.error(`[watchdog] tgSend: ${reason} — тревога никуда не ушла`);
    return { ok: false, reason };
  }
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    // HTTP 200 — единственное доказательство доставки, которое у нас есть.
    // Не читать его значило принимать 403 «bot was blocked» за успех.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const reason = `Telegram ответил ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
      console.error(`[watchdog] tgSend: ${reason}`);
      return { ok: false, reason };
    }
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[watchdog] tgSend: ${reason}`);
    return { ok: false, reason };
  }
}

async function checkUnconfirmedBookings(): Promise<CheckResult> {
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
  } catch (err) {
    // §4.0: «не смог проверить» — не «всё хорошо». Сторож, чей запрос
    // упал, обязан оставить след, иначе поломка неотличима от тишины.
    console.error('[watchdog] checkUnconfirmedBookings:', err instanceof Error ? err.message : err);
    return checkFailure('checkUnconfirmedBookings', err);
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

async function checkOperatorNoResponse(): Promise<CheckResult> {
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
  } catch (err) {
    // §4.0: «не смог проверить» — не «всё хорошо». Сторож, чей запрос
    // упал, обязан оставить след, иначе поломка неотличима от тишины.
    console.error('[watchdog] checkOperatorNoResponse:', err instanceof Error ? err.message : err);
    return checkFailure('checkOperatorNoResponse', err);
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

async function checkUnconfirmedStayBookings(): Promise<CheckResult> {
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
  } catch (err) {
    // §4.0: «не смог проверить» — не «всё хорошо». Сторож, чей запрос
    // упал, обязан оставить след, иначе поломка неотличима от тишины.
    console.error('[watchdog] checkUnconfirmedStayBookings:', err instanceof Error ? err.message : err);
    return checkFailure('checkUnconfirmedStayBookings', err);
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

async function checkPendingGearRentals(): Promise<CheckResult> {
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
  } catch (err) {
    // §4.0: «не смог проверить» — не «всё хорошо». Сторож, чей запрос
    // упал, обязан оставить след, иначе поломка неотличима от тишины.
    console.error('[watchdog] checkPendingGearRentals:', err instanceof Error ? err.message : err);
    return checkFailure('checkPendingGearRentals', err);
  }
}

/**
 * Опасные алерты созданы, но пуш не ушёл.
 *
 * Найдено на живом проде 28.07: в ответе safety-ingest годами висело
 * «VAPID keys not configured — push skipped» — цунами-предупреждения,
 * пожары и дорожные ограничения НЕ доставлялись, и об этом никто не знал:
 * dispatchPushAlerts возвращает ошибку в тело ответа крона, а тело никто
 * не читает. Классическая молчаливая деградация safety-функции.
 *
 * Проверка ловит ЛЮБУЮ причину недоставки (нет VAPID, нет подписок, отказ
 * сервиса) — она смотрит на факт: алерт, подлежащий рассылке, старше
 * 30 минут (шесть пропущенных прогонов пятиминутного крона) и до сих пор
 * без push_sent_at.
 */
async function checkUndeliveredSafetyPush(): Promise<CheckResult> {
  try {
    const { rows } = await pool.query<{ count: string; oldest_title: string | null }>(
      `SELECT COUNT(*)::text AS count,
              (ARRAY_AGG(title ORDER BY created_at ASC))[1] AS oldest_title
         FROM external_alerts
        WHERE (severity >= 2 OR alert_type IN ('tsunami_warning', 'road_closure'))
          AND push_sent_at IS NULL
          AND created_at < NOW() - INTERVAL '30 minutes'
          AND created_at > NOW() - INTERVAL '7 days'
          -- Истёкший недоставленный алерт уже не починить: диспетчер ретраит
          -- только пока expires_at > NOW() (та же граница, 31.07). Кричать о
          -- неисправимом ещё 7 суток — глушить сторож; пока алерт был жив,
          -- сторож бил каждые 30 минут — этого сигнала достаточно.
          AND expires_at > NOW()`,
    );
    const count = parseInt(rows[0]?.count ?? '0', 10);
    if (count === 0) return null;

    // Точный диагноз причины недоставки, а не общее «проверь VAPID и подписки»
    // (из-за него 02.08 ключи чинили полночи, а дыра была в нуле подписчиков).
    // Три разных состояния — три разных действия:
    const vapidSet = !!process.env.NEXT_PUBLIC_VAPID_KEY && !!process.env.VAPID_PRIVATE_KEY;
    // Три состояния, а не два: число, измеренный ноль и «не смог посчитать».
    //
    // До 30.08 `subs` инициализировался нулём, а пустой catch его не трогал —
    // значит отказ запроса становился ИЗМЕРЕННЫМ нулём. Дальше ветка «канал
    // пуст» ниже объявляла фактом «подписчиков 0, доставлять некому» И
    // понижала КРИТ о непредупреждённых туристах до предупреждения. То есть
    // выдуманное число гасило тревогу в контуре безопасности — дословный
    // случай из §4.0 («обязательное число — выдумывается»).
    //
    // null значит «не знаю»: ветка пустого канала на нём не срабатывает,
    // критичность сохраняется, причина называется неустановленной.
    let subs: number | null = null;
    try {
      const s = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM push_subscriptions`);
      subs = parseInt(s.rows[0]?.n ?? '0', 10);
    } catch (err) {
      // Ловить можно, молчать нельзя (§4.0).
      console.error('[watchdog] push_subscriptions count:', err instanceof Error ? err.message : err);
    }

    // ── Пустой канал — не поломка доставки ─────────────────────────────────
    //
    // Здесь алерт был КРИТом безусловно, с текстом «Туристы не предупреждены».
    // При нуле подписчиков он не может позеленеть НИКОГДА: любая запись с
    // severity ≥ 2 держит его до своего истечения, то есть до семи суток, и
    // никакая работа его не гасит. Монитор, который нельзя погасить работой,
    // приучает себя пролистывать — а он же носит настоящие криты (SOS,
    // мёртвый сейсмо-приём).
    //
    // Ноль подписчиков — это ОДИН стоячий факт о воронке, а не N критов о
    // недоставке. Отсутствие получателей приняло вид отказа доставки: тот же
    // класс подмены, что и весь сегодняшний день.
    //
    // КРИТ остаётся там, где он означает действие: подписчики есть, а
    // доставка не проходит. Это чинится. Нет ключей — тоже чинится (задать
    // переменные), и канал закрыт целиком, поэтому тоже КРИТ.
    if (vapidSet && subs === 0) {
      return {
        type: 'push_undelivered',
        count,
        critical: false,
        details:
          `Push-канал пуст: подписчиков 0, доставлять некому. ` +
          `${count} предупрежд(ений) не ушло — это следствие пустого канала, ` +
          `а не отказ доставки. Нужны подписки туристов (промпт на /safety).`,
      };
    }

    const cause = !vapidSet
      ? 'VAPID-ключи не заданы на Timeweb (NEXT_PUBLIC_VAPID_KEY + VAPID_PRIVATE_KEY, нужен передеплой).'
      : subs === null
        // Причина НЕ установлена — и так и сказано. Прежний текст назвал бы
        // здесь «подписок 0», хотя ноль был не измерен, а не получен.
        ? 'VAPID ок, но число подписок посчитать не удалось — причина недоставки не установлена (запрос к push_subscriptions упал, см. лог).'
        : `VAPID ок, подписок ${subs}, но доставка не проходит — проверь endpoint/лимиты push-сервиса.`;

    return {
      type: 'push_undelivered',
      count,
      critical: true,
      details:
        `${count} опасн(ых) алерт(ов) без доставки push > 30 мин ` +
        `(самый ранний: ${(rows[0]?.oldest_title ?? '').slice(0, 80)}). ` +
        `Туристы не предупреждены. ${cause}`,
    };
  } catch (err) {
    // §4.0: «не смог проверить» — не «всё хорошо». Сторож, чей запрос
    // упал, обязан оставить след, иначе поломка неотличима от тишины.
    console.error('[watchdog] checkUndeliveredSafetyPush:', err instanceof Error ? err.message : err);
    return checkFailure('checkUndeliveredSafetyPush', err);
  }
}

async function checkPendingTransferBookings(): Promise<CheckResult> {
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
  } catch (err) {
    // §4.0: «не смог проверить» — не «всё хорошо». Сторож, чей запрос
    // упал, обязан оставить след, иначе поломка неотличима от тишины.
    console.error('[watchdog] checkPendingTransferBookings:', err instanceof Error ? err.message : err);
    return checkFailure('checkPendingTransferBookings', err);
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

/**
 * Всплеск регистраций операторов: сегодня втрое выше медианы за две недели.
 *
 * Резкий наплыв «операторов» — не рост, а типичный след накрутки или чужого
 * скрипта. Движок (`detectRegistrationSpike`) был написан, подписан «used by
 * health cron» и не вызывался ниоткуда — то есть сигнал считался и терялся.
 *
 * Молчим при исходе `unknown` (истории нет — сравнивать не с чем): это не
 * «спокойно», а «судить рано», и поднимать по нему тревогу значит приучить
 * пролистывать её.
 */
async function checkOperatorRegistrationSpike(): Promise<CheckResult> {
  try {
    const spike = await detectRegistrationSpike();
    if (spike.verdict !== 'spike') return null;
    return {
      type: 'operator_registration_spike',
      count: spike.today,
      details:
        `Регистраций операторов сегодня: ${spike.today} при обычных ` +
        `${spike.baseline_median} в день (медиана за 14 дней). Проверить, не накрутка ли.`,
    };
  } catch (err) {
    // Отказ проверки не выдаём за отсутствие всплеска: §4.0 — «не смог» это
    // третий исход, и он обязан попасть хотя бы в лог.
    console.error('[watchdog] checkOperatorRegistrationSpike:', err instanceof Error ? err.message : err);
    return checkFailure('checkOperatorRegistrationSpike', err);
  }
}

/**
 * Платежи, которые пора было отпустить оператору, но они всё ещё удержаны.
 *
 * `/api/cron/payouts` переводит `tour_payments` из HELD в RELEASED, когда
 * наступил `release_after` (конец тура + 36 ч). Шапка роута обещает запуск
 * «каждый час» — но запускает его не GitHub Actions, а внешний планировщик,
 * которого из репозитория не видно (перепись достижимости 22.08,
 * `lib/agents/cron-schedulers.ts`). Проверить чужую панель нельзя; проверить
 * СЛЕД можно, и он однозначен: если джоба идёт, HELD с наступившим сроком
 * живёт максимум час.
 *
 * Порог — 6 часов: шесть пропущенных запусков подряд, случайной задержкой уже
 * не объясняются. Тревога говорит и о деньгах, и о причине: молчащий крон.
 */
async function checkStuckPayouts(): Promise<CheckResult> {
  try {
    const { rows } = await pool.query<{ count: string; total: string | null; oldest_hours: string | null }>(`
      SELECT COUNT(*)::text                                              AS count,
             COALESCE(SUM(net_amount), 0)::text                          AS total,
             MAX(EXTRACT(EPOCH FROM (NOW() - release_after)) / 3600)::text AS oldest_hours
      FROM tour_payments
      WHERE status = 'HELD'
        AND release_after IS NOT NULL
        AND release_after < NOW() - INTERVAL '6 hours'
    `);
    const count = parseInt(rows[0]?.count ?? '0', 10);
    if (count === 0) return null;

    const total = Math.round(parseFloat(rows[0]?.total ?? '0'));
    const oldest = Math.round(parseFloat(rows[0]?.oldest_hours ?? '0'));
    return {
      type: 'payout_release_stuck',
      count,
      critical: true,
      details:
        `${count} платежей на ${total} руб. удерживаются после срока релиза ` +
        `(самый старый — ${oldest} ч). Похоже, /api/cron/payouts не запускается: ` +
        `его планировщик внешний и из репозитория не виден.`,
    };
  } catch (err) {
    // «Не смог проверить» — не «всё хорошо» (§4.0). Деньги оператора: молчать
    // об отказе проверки здесь дороже всего.
    console.error('[watchdog] checkStuckPayouts:', err instanceof Error ? err.message : err);
    return checkFailure('checkStuckPayouts', err);
  }
}

async function checkUnprocessedLeads(): Promise<CheckResult> {
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
  } catch (err) {
    // §4.0: «не смог проверить» — не «всё хорошо». Сторож, чей запрос
    // упал, обязан оставить след, иначе поломка неотличима от тишины.
    console.error('[watchdog] checkUnprocessedLeads:', err instanceof Error ? err.message : err);
    return checkFailure('checkUnprocessedLeads', err);
  }
}

async function checkIgnoredSOS(): Promise<CheckResult> {
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
    return checkFailure('checkIgnoredSOS', err);
  }
}

/**
 * Самый свежий прогон ЛЮБОГО крона — свидетель того, что CRON_SECRET и
 * эндпоинт живы (секрет один на весь префикс `/api/cron/*`). Нужен, чтобы
 * советы про молчание не называли виноватым доказанно исправное — разбор в
 * lib/agents/cron-blame.ts.
 *
 * Отказ запроса возвращает null, и вердикт становится «не смог установить»:
 * §4.0 — непроверенное не равно исправному.
 */
async function readCronWitness(): Promise<CronWitness | null> {
  try {
    const { rows } = await pool.query<{ agent_id: string; min_ago: string }>(`
      SELECT agent_id,
             EXTRACT(EPOCH FROM (NOW() - MAX(ended_at))) / 60 AS min_ago
        FROM agent_run_history
       WHERE ended_at IS NOT NULL
       GROUP BY agent_id
       ORDER BY MAX(ended_at) DESC
       LIMIT 1
    `);
    const r = rows[0];
    if (!r) return null;
    return { agentId: r.agent_id, minutesAgo: Math.max(0, Math.round(Number(r.min_ago))) };
  } catch (err) {
    console.error('[watchdog] readCronWitness failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function checkSeismicCronDead(): Promise<CheckResult> {
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
      const blame = blameSilentCrons(await readCronWitness(), 120);
      return {
        type: 'seismic_cron_dead',
        count: 1,
        details: `КРИТИЧНО: Сейсмо-мониторинг не запускался >2ч. Система слепа к землетрясениям и цунами. ${describeBlame(blame)}`,
      };
    }
    const silenceMin = Math.round((Date.now() - new Date(lastSeen).getTime()) / 60000);
    if (silenceMin > 15) {
      // Причина берётся у СВИДЕТЕЛЯ, а не у часов. Прежде она выводилась из
      // числа минут («>2ч — проверь CRON_SECRET»), и 29.08 этот совет отправил
      // проверять секрет, которым в ту же минуту успешно ходили другие кроны,
      // и вкладку Actions, где все прогоны были зелёные. Разбор — cron-blame.ts.
      const blame = blameSilentCrons(await readCronWitness(), silenceMin);
      return {
        type: 'seismic_cron_dead',
        count: silenceMin,
        details: `КРИТИЧНО: Сейсмо-мониторинг молчит ${silenceMin} мин (норма ≤5 мин). ${describeBlame(blame)}`,
      };
    }
    return null;
  } catch (err) {
    // §4.0: «не смог проверить» — не «всё хорошо». Сторож, чей запрос
    // упал, обязан оставить след, иначе поломка неотличима от тишины.
    console.error('[watchdog] checkSeismicCronDead:', err instanceof Error ? err.message : err);
    return checkFailure('checkSeismicCronDead', err);
  }
}

/**
 * ── Задержка сейсмо-канала из Telegram ─────────────────────────────────────
 *
 * `checkSeismicCronDead` выше меряет ЛЮБОЙ прогон safety-ingest. А его каждые
 * пять минут удовлетворяет heartbeat из start.js — то есть сторож смотрит на
 * путь, который работает, и потому слеп к пути, который опаздывает.
 *
 * Пути два, и они очень разные. USGS и МЧС сервер тянет сам, вовремя. КБГС и
 * EQKam живут в Telegram, а `t.me` для хостинга гео-закрыт — их приносит
 * GitHub Actions, у которого пятиминутное расписание на практике даёт
 * разрывы в 40–60 минут. Про эту задержку мы узнали 14.08 СЛУЧАЙНО, разбирая другой сбой:
 * измерения не было вовсе.
 *
 * Уровни выбраны по цене ошибки, а не по громкости. Задержку расписания
 * GitHub владелец починить не может — КРИТ на неё был бы красным, которое не
 * гаснет работой (этот урок уже стоил нам вечного push_undelivered). А вот
 * остановка воркфлоу чинится: секрет, отключённый workflow, сломанный шаг.
 *
 * ── Перекалибровка 02.09: порог стоял НИЖЕ нормальной работы ────────────────
 *
 * Владелец: «отключи тг канал сейсмики он мертвый». Замер 30 последних
 * прогонов `cron-safety-ingest` показал, что мёртв не канал, а порог:
 *
 *   запрошено расписанием   каждые 5 мин
 *   фактические интервалы   102 … 740 мин, медиана 256
 *
 * При таком разбросе прежний WARN в 90 минут срабатывал на КАЖДОЙ доставке —
 * даже самая быстрая (102 мин) его превышала. КРИТ в 360 минут срабатывал на
 * обычных промежутках (407, 740). То есть тревога сообщала не о поломке, а о
 * том, что расписание GitHub такое, какое есть.
 *
 * Сигнал, который горит при исправной работе, человек выключает — и вместе с
 * ним выключает настоящую поломку, когда она придёт. Поэтому:
 *
 *   WARN снят целиком: «немного опаздывает» в этом диапазоне не существует;
 *   КРИТ поднят выше наблюдаемого максимума с запасом — ниже суток это
 *   расписание, выше суток воркфлоу действительно встал, и ЭТО чинится.
 *
 * Данные при этом НЕ отключены: КБГС и EQKam — единственный источник местных
 * землетрясений, USGS отдаёт только сильные. Гасить их значило бы убрать
 * точки с радара, а не убрать ложную тревогу.
 */
/**
 * Снят 02.09: любое значение выше него было нормой (минимальный наблюдаемый
 * интервал доставки — 102 мин). Оставлен как ноль, чтобы ветка WARN не
 * воскресла случайной правкой числа.
 */
export const SEISMIC_WORKFLOW_WARN_MIN = 0;
/** Сутки: выше наблюдаемого максимума (740 мин) с запасом. */
export const SEISMIC_WORKFLOW_CRIT_MIN = 1440;

/**
 * @param ageMin     минут с последней доставки от воркфлоу; null — доставок нет
 * @param observedMin сколько минут мы вообще наблюдаем приём (по журналу)
 * @param blame      вердикт о виноватом (lib/agents/cron-blame.ts). Необязателен:
 *   без него КРИТ говорит только измеренное и никого не обвиняет. Появился
 *   29.08, когда текст «Это уже не задержка расписания» оказался ложью —
 *   доставка шла раз в 6.5 часов ИМЕННО из-за расписания, а порог в 360 минут
 *   стоял на посылке «столько задержка не длится», к тому дню устаревшей.
 */
export function seismicWorkflowDelayIssue(
  ageMin: number | null,
  observedMin: number,
  blame?: CronBlame,
): WatchdogAlert | null {
  if (ageMin === null) {
    // Ни одной доставки. Судить можно только если наблюдаем дольше, чем
    // разумно ждать первую: сразу после выката строк ещё нет, и алерт здесь
    // был бы ложной тревогой на пустом месте. Та же осторожность, что в
    // evaluateDeadSources (observedHours).
    if (observedMin <= SEISMIC_WORKFLOW_CRIT_MIN) return null;
    return {
      type: 'safety_cron_dead',
      count: Math.round(observedMin),
      critical: true,
      details:
        `Сейсмо-канал Telegram (КБГС, EQKam) не доставлялся НИ РАЗУ за ` +
        `${Math.round(observedMin)} мин наблюдения. Воркфлоу cron-safety-ingest ` +
        `не доходит до сервера. ${blame ? describeBlame(blame) : 'Проверь его прогоны.'} ` +
        `USGS и МЧС идут напрямую и не затронуты.`,
    };
  }
  if (ageMin > SEISMIC_WORKFLOW_CRIT_MIN) {
    // Прежде здесь стояло «Это уже не задержка расписания». Утверждение
    // опиралось на порог, а не на улику, и 29.08 оказалось ложным: доставка
    // шла раз в 6.5 часов именно из-за расписания GitHub. Теперь говорим
    // измеренное, а виноватого называет свидетель — или не называет никто.
    return {
      type: 'safety_cron_dead',
      count: Math.round(ageMin),
      critical: true,
      details:
        `Сейсмо-канал Telegram молчит ${Math.round(ageMin)} мин ` +
        `(порог ${SEISMIC_WORKFLOW_CRIT_MIN}), воркфлоу cron-safety-ingest. ` +
        `${blame ? describeBlame(blame) : 'Проверь его прогоны.'} USGS и МЧС идут напрямую.`,
    };
  }
  // Ветки WARN больше нет: при интервалах 102-740 мин «слегка опаздывает»
  // не бывает, и прежний порог в 90 мин делал тревогу постоянной. Молчание
  // здесь означает «идёт как обычно для этого расписания», а не «свежо».
  return null;
}

async function checkSeismicWorkflowDelay(): Promise<CheckResult> {
  try {
    const { rows } = await pool.query<{ last_post: string | null; first_any: string | null }>(`
      SELECT MAX(ended_at) FILTER (WHERE metadata->>'trigger' = 'workflow_post')::text AS last_post,
             MIN(ended_at)::text                                                        AS first_any
        FROM agent_run_history
       WHERE agent_id = 'safety-ingest'
         AND ended_at > NOW() - INTERVAL '7 days'
    `);
    const now = Date.now();
    const lastPost = rows[0]?.last_post ?? null;
    const firstAny = rows[0]?.first_any ?? null;
    if (!firstAny) return null; // приёма нет вовсе — это забота checkSeismicCronDead
    const observedMin = (now - new Date(firstAny).getTime()) / 60_000;
    const ageMin = lastPost === null ? null : (now - new Date(lastPost).getTime()) / 60_000;
    return seismicWorkflowDelayIssue(ageMin, observedMin, blameSilentCrons(await readCronWitness(), observedMin));
  } catch (err) {
    // §4.0: «не смог проверить» — не «всё хорошо». Сторож, чей запрос
    // упал, обязан оставить след, иначе поломка неотличима от тишины.
    console.error('[watchdog] checkSeismicWorkflowDelay:', err instanceof Error ? err.message : err);
    return checkFailure('checkSeismicWorkflowDelay', err);
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
 * Два порога, а не один. Причина — измерение: 28.07 пришёл КРИТ «safety-агент не
 * отвечает» по danger-analysis и sos-events-bridge, а оба крона в тот момент
 * отрабатывали успешно. Виновата была не платформа, а расписание GitHub
 * Actions: у 30-минутного крона наблюдались разрывы между прогонами до 3ч47м
 * (227 мин) при пороге 150. Ложный КРИТ на платформе безопасности дороже
 * пропущенного: он приучает не читать алерты.
 *
 * Поэтому молчание между порогами — ВНИМАНИЕ («прогон не отмечался»), и только
 * сверх верхнего порога — КРИТ. Верхний взят с запасом от наблюдавшегося
 * максимума: 6 ч — это дюжина пропущенных прогонов 30-минутного крона, столько
 * штатная задержка не длится.
 *
 * Формулировка тоже изменена. «Агент не отвечает» — утверждение о состоянии
 * агента, которого liveness не знает: он видит только отметку о последнем
 * прогоне в agent_run_history. Алерт говорит ровно то, что измерено.
 */
const GITHUB_DELAY_FLOOR_MIN = 150;
const SAFETY_CRON_CRITICAL_MIN = 360;

async function checkDeadSafetyCrons(): Promise<CheckResult> {
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
    const silent: string[] = [];
    let worstMinutes = 0;
    for (const e of entries) {
      const last = lastById.get(e.agentId as string) ?? null;
      const lastMs = last ? new Date(last).getTime() : null;
      const lv = computeLiveness(e, lastMs, now);
      // 'dead' по liveness И сверх floor задержки GitHub Actions — иначе штатная
      // задержка scheduled-cron поднимала тревогу на ровном месте.
      if (lv.status === 'dead' && (lv.minutesSince ?? 0) >= GITHUB_DELAY_FLOOR_MIN) {
        const mins = lv.minutesSince ?? 0;
        worstMinutes = Math.max(worstMinutes, mins);
        const ago = mins > 120 ? `${Math.round(mins / 60)}ч` : `${mins} мин`;
        silent.push(`${e.label} — прогон не отмечался ${ago} (расписание: ${e.schedule})`);
      }
    }
    if (silent.length === 0) return null;

    const critical = worstMinutes >= SAFETY_CRON_CRITICAL_MIN;
    // Совет выводится из СВИДЕТЕЛЯ, а не из порога минут. Прежняя развилка
    // («сверх 6ч — проверь CRON_SECRET») опиралась на посылку «столько
    // штатная задержка не длится»: в июле верную, к концу августа — нет.
    // 29.08 она выдала КРИТ с советом проверить секрет и Actions, где всё
    // было исправно: прогоны зелёные, секрет живой. Длительность молчания о
    // причине молчания не говорит ничего — разбор в lib/agents/cron-blame.ts.
    const hint = describeBlame(blameSilentCrons(await readCronWitness(), worstMinutes));

    return {
      type: 'safety_cron_dead',
      count: silent.length,
      critical,
      details: `${silent.join('; ')}. ${hint}`,
    };
  } catch (err) {
    console.error('[watchdog] checkDeadSafetyCrons failed:', err);
    return checkFailure('checkDeadSafetyCrons', err);
  }
}

/**
 * Кроны, которые запускаются и ничего не делают. Второй вопрос после «жив ли»:
 * liveness видит только факт запуска, а KVERT в день выброса Шивелуча был жив,
 * зелен и слеп. Судим лишь там, где ноль объявлен ненормальным, и лишь по серии
 * подряд — разбор порога и оговорок в lib/agents/cron-idle.ts.
 */
async function checkIdleCrons(): Promise<CheckResult> {
  try {
    const ids = CRON_REGISTRY.map(e => e.agentId).filter((id): id is string => id !== null);
    if (ids.length === 0) return null;

    // Берём с запасом по прогонам на агента: окно среза — в чистой функции.
    const { rows } = await pool.query<CronRunRow>(
      `SELECT agent_id, items_processed AS items, ended_at::text AS ended_at
         FROM agent_run_history
        WHERE agent_id = ANY($1) AND status = 'success' AND ended_at IS NOT NULL
        ORDER BY ended_at DESC
        LIMIT $2`,
      [ids, ids.length * IDLE_RUNS_THRESHOLD * 4],
    );

    const idle = findIdleCrons(CRON_REGISTRY, rows);
    if (idle.length === 0) return null;

    const safetyKeys = new Set(CRON_REGISTRY.filter(e => e.tier === 'safety').map(e => e.key));
    const critical = idle.some(c => safetyKeys.has(c.key));

    return {
      type: 'cron_idle',
      count: idle.length,
      critical,
      details: `Крон отчитывается успехом, не делая работы — ${formatIdleCrons(idle)}.`,
    };
  } catch (err) {
    console.error('[watchdog] checkIdleCrons failed:', err);
    return checkFailure('checkIdleCrons', err);
  }
}

/**
 * Кроны, которые падают подряд. Третий вопрос после «жив ли» и «сделал ли».
 *
 * Между ними есть щель: liveness читает историю без разбора статуса и считает
 * упавший прогон отметкой о жизни; сторож холостых берёт `status = 'success'` и
 * у постоянно падающего не находит истории вовсе. Синк авиационных кодов
 * вулканов прожил в этой щели тринадцать дней. Разбор — в lib/agents/cron-failing.ts.
 */
async function checkFailingCrons(): Promise<CheckResult> {
  try {
    const ids = CRON_REGISTRY.map(e => e.agentId).filter((id): id is string => id !== null);
    if (ids.length === 0) return null;

    // Статус берём вместе со строкой: срез окна — в чистой функции.
    const { rows } = await pool.query<CronStatusRow>(
      `SELECT agent_id, status, ended_at::text AS ended_at, error_msg AS error
         FROM agent_run_history
        WHERE agent_id = ANY($1) AND ended_at IS NOT NULL
        ORDER BY ended_at DESC
        LIMIT $2`,
      [ids, ids.length * FAILING_RUNS_THRESHOLD * 4],
    );

    const failing = findFailingCrons(CRON_REGISTRY, rows);
    if (failing.length === 0) return null;

    const safetyKeys = new Set(CRON_REGISTRY.filter(e => e.tier === 'safety').map(e => e.key));
    const critical = failing.some(c => safetyKeys.has(c.key));

    return {
      type: 'cron_failing',
      count: failing.length,
      critical,
      details: `Крон отчитывается отказом подряд — ${formatFailingCrons(failing)}.`,
    };
  } catch (err) {
    console.error('[watchdog] checkFailingCrons failed:', err);
    return checkFailure('checkFailingCrons', err);
  }
}

/**
 * Миграции, которые не применились. Раннер намеренно не роняет деплой на
 * упавшей миграции (пишет «[migrate] ✗», считает ошибку и всё равно поднимает
 * сервер) — решение верное: платформа, которой пользуются в поле, не должна
 * ложиться из-за одной кривой миграции. Но провал при этом оставался строчкой
 * в логе деплоя, которую никто не читает на следующий день, а схема тихо
 * расходилась с кодом. Сравниваем файлы на диске с таблицей учёта.
 */
/**
 * Кроны, которые идут и не доводят дело до конца. Четвёртый вопрос.
 *
 * 23.08.2026: разведчик молчал двадцать два дня при зелёном кроне. Каждое утро
 * он запускался, находил свежие материалы в лентах — значит для сторожа
 * холостых «работу сделал», — и не выпускал ничего, потому что фактчек-судья
 * не мог ответить: провайдеры молчали. Статус таких прогонов `partial`, а
 * сторож падающих считает только `failed`. Двадцать два прогона подряд не
 * подняли ни одной тревоги, и немоту нашёл владелец руками.
 *
 * Разбор порога и оговорок — в lib/agents/cron-fruitless.ts.
 */
async function checkFruitlessCrons(): Promise<CheckResult> {
  try {
    const ids = CRON_REGISTRY.map(e => e.agentId).filter((id): id is string => id !== null);
    if (ids.length === 0) return null;

    // Причину пропуска крон кладёт в metadata; берём её вместе со статусом,
    // иначе тревога скажет «молчит» и не скажет, где чинить.
    //
    // Ключ ОБЩИЙ — `skip_reason`. Читать только `digest_skip_reason` значило
    // спрашивать причину у одного разведчика: любой другой крон в эту графу
    // не попадал по построению, и 23.08 тревога так и сказала про Intelligence
    // Monitor — «причина пропуска не записана». Исторический ключ разведчика
    // оставлен вторым: в уже записанных прогонах лежит он.
    const { rows } = await pool.query<CronOutcomeRow>(
      `SELECT agent_id, status, ended_at::text AS ended_at,
              COALESCE(metadata->>'skip_reason', metadata->>'digest_skip_reason') AS skip_reason
         FROM agent_run_history
        WHERE agent_id = ANY($1) AND ended_at IS NOT NULL
        ORDER BY ended_at DESC
        LIMIT $2`,
      [ids, ids.length * FRUITLESS_RUNS_THRESHOLD * 8],
    );

    const fruitless = findFruitlessCrons(CRON_REGISTRY, rows, Date.now());
    if (fruitless.length === 0) return null;

    const safetyKeys = new Set(CRON_REGISTRY.filter(e => e.tier === 'safety').map(e => e.key));
    return {
      type: 'cron_fruitless',
      count: fruitless.length,
      critical: fruitless.some(c => safetyKeys.has(c.key)),
      details: `Крон идёт, но результата нет — ${formatFruitlessCrons(fruitless)}.`,
    };
  } catch (err) {
    console.error('[watchdog] checkFruitlessCrons:', err instanceof Error ? err.message : err);
    return checkFailure('checkFruitlessCrons', err);
  }
}

async function checkUnappliedMigrations(): Promise<CheckResult> {
  try {
    const dir = join(process.cwd(), 'migrations');
    const files = readdirSync(dir).filter(f => f.endsWith('.sql'));
    if (files.length === 0) return null; // каталога нет в образе — не судим

    const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
    const unapplied = findUnappliedMigrations(files, rows.map(r => r.name));
    if (unapplied.length === 0) return null;

    // Причина падения — там же, в базе. Раньше она уезжала отдельным алертом, а
    // это письмо отправляло человека в лог деплоя за тем, что у нас уже есть.
    const reasons: Record<string, string> = {};
    const failures = await pool.query<{ name: string; error: string }>(
      `SELECT name, error FROM _migration_failures WHERE name = ANY($1::text[])`,
      [unapplied],
    ).catch(() => ({ rows: [] as Array<{ name: string; error: string }> }));
    for (const f of failures.rows) reasons[f.name] = f.error ?? '';

    return {
      type: 'migration_unapplied',
      count: unapplied.length,
      details: formatUnappliedMigrations(unapplied, reasons),
    };
  } catch (err) {
    console.error('[watchdog] checkUnappliedMigrations failed:', err);
    return checkFailure('checkUnappliedMigrations', err);
  }
}

/**
 * Миграция ПЫТАЛАСЬ примениться и УПАЛА.
 *
 * Повод (август 2026): миграция 806 упала на деплое и молчала. Формально её
 * ловил `checkUnappliedMigrations` — упавшая ведь не попадает в `_migrations`.
 * Но «не применены N миграций» читается как задержка деплоя и пролистывается, а
 * причина падения лежала в `_migration_failures` непрочитанной. Итог: тур
 * пропал с витрины, потом отдавал 404, потом остался без галереи — три дня
 * ловли симптомов вместо одной строки «806: column ... does not exist».
 *
 * `start.js` намеренно не роняет деплой при сбое миграции — сервер поднимется в
 * любом случае. Значит единственный, кто может об этом сказать, — сторож.
 */
async function checkFailedMigrations(): Promise<CheckResult> {
  try {
    const { rows } = await pool.query<{ name: string; error: string; attempts: number }>(
      `SELECT name, error, attempts
         FROM _migration_failures
        ORDER BY last_failed_at DESC
        LIMIT 5`,
    );
    if (rows.length === 0) return null;

    const details = rows
      .map(r => `${r.name} (попыток: ${r.attempts}): ${String(r.error ?? '').slice(0, 200)}`)
      .join('\n');

    return {
      type: 'migration_failed',
      count: rows.length,
      details,
      // Упавшая миграция — это расхождение кода и схемы: код уже раздаётся и
      // рассчитывает на колонки, которых нет. Пролистывать такое нельзя.
      critical: true,
    };
  } catch (err) {
    // Таблицы может не быть на свежем окружении — это не повод для тревоги.
    console.error('[watchdog] checkFailedMigrations failed:', err);
    return checkFailure('checkFailedMigrations', err);
  }
}

export async function runWatchdog(): Promise<WatchdogResult> {
  const start = Date.now();

  // Проверки перечислены СПИСКОМ, а не позиционной деструктуризацией.
  //
  // Так было до 22.08.2026: пятнадцать вызовов в `Promise.all` разбирались в
  // четырнадцать имён. Лишний вызов молча уезжал за край — `checkFailedMigrations()`
  // выполнялся каждые полчаса, и его результат выбрасывался: тревога «миграция
  // упала» не срабатывала ни разу. Заодно все имена, начиная с девятого,
  // держали чужое значение, и читать этот код было нельзя.
  //
  // Позиционное сопоставление длинного списка — ловушка без сигнала: добавил
  // проверку, забыл имя — и потеря выглядит как тишина. Здесь имён нет, терять
  // нечего. Сторож состава — `tests/unit/watchdog-checks-wired.test.ts`.
  const CHECKS: Array<() => Promise<CheckResult>> = [
    checkUnconfirmedBookings,
    checkUnconfirmedStayBookings,
    checkPendingGearRentals,
    checkPendingTransferBookings,
    checkOperatorNoResponse,
    checkOperatorRegistrationSpike,
    checkStuckPayouts,
    checkUnprocessedLeads,
    checkIgnoredSOS,
    checkSeismicCronDead,
    // Отдельно от предыдущей: та меряет ЛЮБОЙ прогон и удовлетворяется
    // heartbeat'ом, который Telegram получить не может. Задержка канала,
    // приносящего КБГС и EQKam, до этой правки не измерялась вовсе.
    checkSeismicWorkflowDelay,
    checkDeadSafetyCrons,
    checkUndeliveredSafetyPush,
    checkIdleCrons,
    checkFailingCrons,
    checkFruitlessCrons,
    checkUnappliedMigrations,
    checkFailedMigrations,
  ];

  const results = await Promise.all(CHECKS.map(run => run()));

  // Три исхода разбираются здесь, а не схлопываются в «непустое» (§4.0).
  const alerts: WatchdogAlert[] = [];
  const failed: Array<{ check: string; reason: string }> = [];
  for (const r of results) {
    if (r === null) continue;                                    // проверено, чисто
    if (isCheckFailure(r)) failed.push({ check: r.check, reason: r.reason });
    else alerts.push(r);
  }
  const checks: WatchdogChecks = { total: CHECKS.length, failed };

  let delivery: WatchdogDelivery = { status: 'nothing_to_send' };

  // Непроверенное — само по себе повод написать владельцу. Иначе всё
  // сегодняшнее упражнение осталось бы в поле результата, которое читают
  // так же редко, как лог: при недоступной БД alerts пуст, и без этой ветки
  // Telegram молчал бы ровно как раньше.
  if (alerts.length > 0 || failed.length > 0) {
    const lines: string[] = ['<b>Watchdog — требует внимания</b>', ''];
    for (const a of alerts) {
      // push_undelivered из этого списка убран: его уровень решает причина, а
      // не тип. При нуле подписчиков «турист не получил предупреждение» верно,
      // но неисправимо этим алертом — и КРИТ висел бы неделю, пока запись не
      // истечёт. Теперь уровень ставит сама проверка через `critical`.
      //
      // safety_cron_dead убран по той же логике раньше: молчание крона бывает
      // и задержкой расписания GitHub, поэтому решает длительность молчания,
      // а не сам тип алерта.
      const prefix = a.critical || a.type === 'seismic_cron_dead' || a.type === 'sos_ignored' ? 'КРИТ:' : 'ВНИМАНИЕ:';
      lines.push(`${prefix} ${a.details}`);
    }
    // «Не смог проверить» идёт отдельным блоком и НЕ смешивается с
    // нарушениями: у них разная природа и разное действие. Нарушение чинят
    // в предметной области, отказ проверки — в самом стороже или в БД.
    if (failed.length > 0) {
      lines.push('', `<b>НЕ ПРОВЕРЕНО: ${failed.length} из ${checks.total}</b>`);
      for (const f of failed.slice(0, 6)) {
        lines.push(`· ${f.check}: ${f.reason.slice(0, 160)}`);
      }
      if (failed.length > 6) lines.push(`· и ещё ${failed.length - 6}`);
      lines.push('Это не «нарушений нет» — по этим проверкам ответа нет вовсе.');
    }

    const adminUrl = getPublicBaseUrl();
    lines.push('', `<a href="${adminUrl}/hub/admin">Открыть панель</a>`);
    const sent = await tgSend(lines.join('\n'));
    delivery = sent.ok ? { status: 'delivered' } : { status: 'failed', reason: sent.reason };
  }

  return {
    alerts,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - start,
    delivery,
    checks,
  };
}
