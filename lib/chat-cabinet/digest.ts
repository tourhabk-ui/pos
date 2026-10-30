/**
 * Ежедневная сводка кабинета в чате (решение владельца 30.10, «всё сразу +
 * Telegram»): раз в камчатские сутки партнёру, у которого что-то ждёт ответа
 * или подошёл срок задачи. Зовёт крон напоминаний
 * (`GET /api/cron/crm-reminders`, каждые 30 минут) третьим прогоном после
 * задач и входящих.
 *
 * Когда — выбирает партнёр (слово владельца 30.10 «сводка: время и
 * выключить», 1353): утром с 08:00, днём с 13:00, вечером с 18:00 по Камчатке
 * или никогда — кнопкой «Ежедневная сводка» в «Ещё» (`chat_cabinet_settings`).
 * Строки нет — утром, как было до настройки. Окна — `DIGEST_WINDOWS`
 * (lib/chat-cabinet/screens), по четыре часа.
 *
 * Правила:
 *  - **Кому.** Карточкам, у которых кабинет в чате есть (`menuRoleOf`:
 *    туроператор, перевозчик, жильё, гид; не пилот проката) и чат — их
 *    кабинет: на одном чате две карточки — сводку получает та, чей кабинет
 *    открывают кнопки (старшая, как `findPartnerByChat`).
 *  - **Нечего сказать — молчим.** Ни входящих, ни задач на сегодня — строка
 *    `empty`, сообщения нет: сводка «у вас ничего» — шум.
 *  - **Один раз в сутки.** Строка `crm_chat_digests` ставится до отправки
 *    (`sending`) и снимается при отказе: повтор — в следующем прогоне, второй
 *    сводки за день нет и при гонке двух прогонов.
 *  - **ПД только в MAX.** В MAX — через `sendPdAlert` (заголовки задач и
 *    подпись клиента «Анна П.»), с кнопками кабинета; в его заглушку Telegram
 *    — только числа и ссылка. Чата MAX у кабинета нет — сводка в Telegram
 *    сразу без ПД, с кнопками кабинета (`cb:` в Telegram работает, экраны
 *    там без имён).
 *  - **Отказ чтения не глушится** (§4.0): не прочитались входящие или задачи
 *    — сводки нет, строка не ставится, в отчёте `read_failed`; не прочитался
 *    один вид входящих — сводка говорит, что именно не прочиталось.
 *  - **Окно в четыре часа, а не в два.** Крон идёт каждые 30 минут, но
 *    планировщик GitHub сбивает запуски в кучи раз в 2–5 часов (CLAUDE.md,
 *    20.09): в окно 08–10 прогон мог не попасть ни один. Второй сводки
 *    широкое окно не даёт — её держит строка дня.
 *  - **«Застрял» — про путь, а не про одного партнёра.** Не дошла сводка
 *    одному (бот заблокирован) — он остаётся в каждом прогоне окна. Прогон,
 *    где он один и не дошёл, путь не опровергает, если сегодня сводка уже
 *    кому-то дошла (`done_today`): иначе шаг краснел бы каждые полчаса до
 *    полудня из-за одного чата.
 */

import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { crmCategoryFor } from '@/lib/crm/partner-context';
import { loadInbox, type Inbox } from '@/lib/crm/inbox';
import { listTasks, type TaskItem } from '@/lib/crm/tasks';
import { INBOX_KIND_LABELS, type InboxKind } from '@/lib/crm/inbox-kinds';
import { contactLabel } from '@/lib/crm/tools';
import { kamchatkaHour } from '@/lib/crm/reminders';
import { kamchatkaDate, kamchatkaDayStart, shiftDate } from '@/lib/analytics/kamchatka-day';
import { sendPdAlert, type PdAlertParams, type PdAlertResult } from '@/lib/notifications/pd-alert';
import { telegramService } from '@/lib/notifications/telegram';
import { escapeHtml } from '@/lib/text/escape-html';
import { menuRoleOf } from '@/lib/roles/role-menu';
import { waitingAge } from '@/lib/roles/inbox-text';
import { cabinetPayload } from '@/lib/chat-cabinet/payload';
import { digestSlotOfHour, dueWords, siteUrl, type CabinetRole } from '@/lib/chat-cabinet/screens';
import type { DigestMode } from '@/lib/chat-cabinet/payload';
import { telegramCabinetKeyboard } from '@/lib/chat-cabinet/render';

interface Queryable {
  query: typeof pool.query;
}

export const DIGEST_TASKS_SHOWN = 5;
export const DIGEST_BATCH = 300;

/**
 * Кабинеты в чате, которым сегодня сводки ещё не было и чьё окно идёт сейчас.
 * `$1` — камчатская дата, `$3` — окно этого часа (`digestSlotOfHour`).
 */
export const DIGEST_CANDIDATES_SQL = `
  SELECT p.id::text AS partner_id, p.category, NULLIF(btrim(p.slug), '') AS slug, p.user_id::text AS user_id,
         p.profile_status, p.max_chat_id::text AS max_chat_id, p.telegram_chat_id::text AS telegram_chat_id,
         (p.max_chat_id IS NOT NULL AND (
           SELECT o.id FROM partners o WHERE o.max_chat_id = p.max_chat_id
            ORDER BY o.created_at ASC NULLS LAST, o.id ASC LIMIT 1) = p.id) AS max_cabinet,
         (p.telegram_chat_id IS NOT NULL AND (
           SELECT o.id FROM partners o WHERE o.telegram_chat_id = p.telegram_chat_id
            ORDER BY o.created_at ASC NULLS LAST, o.id ASC LIMIT 1) = p.id) AS telegram_cabinet,
         EXISTS (SELECT 1 FROM operator_tours own
                  WHERE own.operator_id = p.id AND own.deleted_at IS NULL) AS sells_tours
    FROM partners p
   WHERE (p.max_chat_id IS NOT NULL OR p.telegram_chat_id IS NOT NULL)
     AND p.category IN ('operator', 'transfer', 'stay', 'guide')
     AND NOT EXISTS (SELECT 1 FROM crm_chat_digests d WHERE d.partner_id = p.id AND d.digest_date = $1::date)
     AND COALESCE((SELECT s.digest FROM chat_cabinet_settings s WHERE s.partner_id = p.id), 'morning') = $3
   ORDER BY p.id
   LIMIT $2`;

export const DIGEST_CLAIM_SQL = `
  INSERT INTO crm_chat_digests (partner_id, digest_date, channel)
  VALUES ($1::uuid, $2::date, $3)
  ON CONFLICT (partner_id, digest_date) DO NOTHING
  RETURNING partner_id`;

export const DIGEST_FINISH_SQL = `
  UPDATE crm_chat_digests SET channel = $3
   WHERE partner_id = $1::uuid AND digest_date = $2::date AND channel = 'sending'`;

/** Сколько кабинетов сегодня уже разобрано (дошло, пусто, некуда). */
export const DIGEST_DONE_TODAY_SQL = `
  SELECT count(*)::int AS n FROM crm_chat_digests
   WHERE digest_date = $1::date AND channel <> 'sending'`;

export const DIGEST_RELEASE_SQL = `
  DELETE FROM crm_chat_digests
   WHERE partner_id = $1::uuid AND digest_date = $2::date AND channel = 'sending'`;

export interface DigestCandidate {
  partner_id: string;
  category: string;
  slug: string | null;
  user_id: string | null;
  profile_status: string | null;
  max_chat_id: string | null;
  telegram_chat_id: string | null;
  max_cabinet: boolean;
  telegram_cabinet: boolean;
  sells_tours: boolean;
}

export interface DigestFacts {
  inbox: Inbox;
  /** Открытые задачи со сроком до конца камчатских суток — по сроку. */
  due: TaskItem[];
  overdue: number;
}

function kindCounts(inbox: Inbox): string {
  const by = new Map<InboxKind, number>();
  for (const i of inbox.items) by.set(i.kind, (by.get(i.kind) ?? 0) + 1);
  return [...by.entries()].map(([k, n]) => `${INBOX_KIND_LABELS[k]} ${n}`).join(', ');
}

/** Есть что сказать: кто-то ждёт ответа, подошёл срок задачи или что-то не прочиталось. */
export function digestHasNews(f: DigestFacts): boolean {
  return f.inbox.items.length > 0 || f.due.length > 0 || f.inbox.failed.length > 0;
}

/**
 * Текст сводки. `max` — с заголовками задач и подписью клиента (только MAX);
 * иначе — числа без ПД, для Telegram. Всё, что ввели люди, экранируется.
 */
const DIGEST_TITLE: Readonly<Record<Exclude<DigestMode, 'off'>, string>> = {
  morning: 'Доброе утро. Кабинет на сегодня',
  day: 'Кабинет: что ждёт сейчас',
  evening: 'Кабинет: итог дня',
};

export function digestText(
  f: DigestFacts,
  channel: 'max' | 'telegram',
  nowMs: number,
  slot: Exclude<DigestMode, 'off'> = 'morning',
): string {
  const lines = [`<b>${DIGEST_TITLE[slot]}</b>`];
  const n = f.inbox.items.length;
  if (n > 0) {
    lines.push(`Ждут ответа: ${n} — ${kindCounts(f.inbox)}.`);
    const longest = Math.max(...f.inbox.items.map((i) => i.waiting_minutes));
    lines.push(`Дольше всех ждёт: ${waitingAge(longest)}.`);
  } else if (f.inbox.failed.length === 0) {
    lines.push('Ответа никто не ждёт.');
  }
  if (f.inbox.failed.length > 0) {
    lines.push(`Не прочиталось: ${f.inbox.failed.map((k) => INBOX_KIND_LABELS[k]).join(', ')} — это не «ничего нет».`);
  }
  if (f.due.length > 0) {
    lines.push(`Задачи на сегодня: ${f.due.length}, из них просрочено: ${f.overdue}.`);
    if (channel === 'max') {
      for (const t of f.due.slice(0, DIGEST_TASKS_SHOWN)) {
        const who = t.contact ? ` · ${escapeHtml(contactLabel(t.contact.display_name))}` : '';
        lines.push(`• ${escapeHtml(t.title)} — ${dueWords(t.due_at, nowMs)}${who}`);
      }
      if (f.due.length > DIGEST_TASKS_SHOWN) lines.push(`…и ещё ${f.due.length - DIGEST_TASKS_SHOWN}`);
    } else {
      lines.push('Заголовки задач и имена клиентов в Telegram не пересылаются — они в MAX и в кабинете.');
    }
  }
  lines.push('Кнопки ниже открывают кабинет прямо в этом чате. Сводка — раз в день, когда что-то ждёт; время или «не присылать» — кнопкой «Время сводки».');
  return lines.join('\n');
}

export interface DigestReport {
  /** Прогон пришёлся на окно сводки. Вне окна остальные числа — нули. */
  window: boolean;
  /** Окно этого прогона (`DIGEST_WINDOWS`); вне окон — null. */
  slot: Exclude<DigestMode, 'off'> | null;
  candidates: number;
  sent_max: number;
  sent_tg: number;
  /** Сводка в MAX не дошла, ушла заглушкой в Telegram (без ПД). */
  sent_stub: number;
  empty: number;
  unreachable: number;
  failed: number;
  read_failed: number;
  /** Список кабинетов не прочитался — прогон ничего не разослал (§4.0: не «некому»). */
  query_failed: boolean;
  truncated: boolean;
  /**
   * Кабинетов, разобранных сегодня раньше. Считается, только когда этот
   * прогон ничего не разобрал и были отказы; null — не считали или счёт не
   * прочитался (тогда отказ прогона — отказ пути).
   */
  done_today: number | null;
}

export interface DigestDeps {
  db?: Queryable;
  read?: (c: DigestCandidate, nowMs: number) => Promise<DigestFacts | null>;
  sendPd?: (p: PdAlertParams) => Promise<PdAlertResult>;
  sendTelegram?: (chatId: string, text: string, replyMarkup: ReturnType<typeof telegramCabinetKeyboard>) => Promise<boolean>;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

async function readFacts(c: DigestCandidate, nowMs: number): Promise<DigestFacts | null> {
  const crm = crmCategoryFor(c.category, c.profile_status);
  if (!crm) return null;
  try {
    const [inbox, open] = await Promise.all([
      loadInbox(c.partner_id, crm, c.user_id, { nowMs }),
      listTasks(c.partner_id, { status: 'open' }),
    ]);
    const end = kamchatkaDayStart(shiftDate(kamchatkaDate(new Date(nowMs)), 1)).getTime();
    const due = open.filter((t) => Date.parse(t.due_at) < end);
    return { inbox, due, overdue: due.filter((t) => Date.parse(t.due_at) < nowMs).length };
  } catch (err) {
    console.error(`[chat-digest] данные сводки не прочитаны — отказ, SQLSTATE ${sqlstate(err)}`);
    return null;
  }
}

async function sendTelegramDigest(
  chatId: string,
  text: string,
  replyMarkup: ReturnType<typeof telegramCabinetKeyboard>,
): Promise<boolean> {
  const r = await telegramService.sendMessage({ chatId, text, parseMode: 'HTML', replyMarkup });
  if (!r.success) console.error('[chat-digest] сводка в Telegram не ушла:', r.error);
  return r.success;
}

export async function runChatDigest(now: Date, deps: DigestDeps = {}): Promise<DigestReport> {
  const db = deps.db ?? pool;
  const read = deps.read ?? readFacts;
  const sendPd = deps.sendPd ?? sendPdAlert;
  const sendTg = deps.sendTelegram ?? sendTelegramDigest;
  const report: DigestReport = {
    window: false, slot: null, candidates: 0, sent_max: 0, sent_tg: 0, sent_stub: 0, empty: 0, unreachable: 0,
    failed: 0, read_failed: 0, query_failed: false, truncated: false, done_today: null,
  };
  const slot = digestSlotOfHour(kamchatkaHour(now));
  if (slot === null) return report;
  report.window = true;
  report.slot = slot;
  const day = kamchatkaDate(now);
  const nowMs = now.getTime();

  let rows: DigestCandidate[];
  try {
    ({ rows } = await db.query<DigestCandidate>(DIGEST_CANDIDATES_SQL, [day, DIGEST_BATCH, slot]));
  } catch (err) {
    console.error(`[chat-digest] кабинеты для сводки не прочитаны — отказ, SQLSTATE ${sqlstate(err)}`);
    return { ...report, query_failed: true };
  }
  report.candidates = rows.length;
  report.truncated = rows.length === DIGEST_BATCH;

  const claim = async (partnerId: string, channel: 'sending' | 'empty' | 'unreachable'): Promise<boolean> => {
    const r = await db.query(DIGEST_CLAIM_SQL, [partnerId, day, channel]);
    return (r.rowCount ?? 0) > 0;
  };

  const digestOne = async (c: DigestCandidate): Promise<void> => {
    const role = menuRoleOf({ partnerId: c.partner_id, category: c.category, slug: c.slug, sellsTours: c.sells_tours });
    if (!role || (!c.max_cabinet && !c.telegram_cabinet)) {
      // Кабинета в чате у карточки нет, или её чат — кабинет другой карточки.
      if (await claim(c.partner_id, 'unreachable')) report.unreachable += 1;
      return;
    }
    const facts = await read(c, nowMs);
    if (!facts) {
      report.read_failed += 1;
      return;
    }
    if (!digestHasNews(facts)) {
      if (await claim(c.partner_id, 'empty')) report.empty += 1;
      return;
    }
    if (!(await claim(c.partner_id, 'sending'))) return; // сводку уже взял соседний прогон
    const base = getPublicBaseUrl();
    const cabinet = { text: 'Кабинет на сайте', url: siteUrl(base, role as CabinetRole) };
    const tgText = digestText(facts, 'telegram', nowMs, slot);
    const deliver = async (): Promise<'max' | 'telegram' | null> => {
      if (c.max_cabinet && c.max_chat_id) {
        const res = await sendPd({
          text: digestText(facts, 'max', nowMs, slot),
          stub: tgText,
          buttons: [
            { text: 'Входящие', payload: cabinetPayload.openInbox() },
            { text: 'Задачи', payload: cabinetPayload.openTasks() },
            { text: 'Время сводки', payload: cabinetPayload.openDigest() },
            cabinet,
          ],
          // Заглушка — только в Telegram-кабинет этой же карточки.
          to: { maxChatId: c.max_chat_id, telegramChatId: c.telegram_cabinet ? c.telegram_chat_id : null },
        });
        if (res.channel === 'max') {
          report.sent_max += 1;
          return 'max';
        }
        if (res.channel === 'telegram-stub') {
          report.sent_stub += 1;
          return 'telegram';
        }
        console.error('[chat-digest] сводка не доставлена, повтор в следующем прогоне:', res.reason);
        return null;
      }
      if (c.telegram_cabinet && c.telegram_chat_id) {
        const ok = await sendTg(c.telegram_chat_id, tgText, telegramCabinetKeyboard([
          [{ text: 'Входящие', payload: cabinetPayload.openInbox() }, { text: 'Задачи', payload: cabinetPayload.openTasks() }],
          [{ text: 'Время сводки', payload: cabinetPayload.openDigest() }],
          [cabinet],
        ]));
        if (ok) {
          report.sent_tg += 1;
          return 'telegram';
        }
      }
      return null;
    };
    // Отправка бросила — строка снимается, как при отказе: иначе сводка этого
    // кабинета стояла бы «отправляется» до конца дня, не уйдя.
    let channel: 'max' | 'telegram' | null = null;
    try {
      channel = await deliver();
    } catch (err) {
      console.error(`[chat-digest] отправка сводки бросила — повтор в следующем прогоне: ${err instanceof Error ? err.name : 'отказ'}`);
    }
    if (channel) {
      await db.query(DIGEST_FINISH_SQL, [c.partner_id, day, channel]);
    } else {
      report.failed += 1;
      await db.query(DIGEST_RELEASE_SQL, [c.partner_id, day]);
    }
  };

  for (const c of rows) {
    try {
      await digestOne(c);
    } catch (err) {
      // Отказ записи строки сводки — этот кабинет в следующем прогоне, остальные идут дальше.
      console.error(`[chat-digest] сводка кабинета — отказ, SQLSTATE ${sqlstate(err)}`);
      report.failed += 1;
    }
  }
  const processed = report.sent_max + report.sent_tg + report.sent_stub + report.empty + report.unreachable;
  if (report.failed + report.read_failed > 0 && processed === 0) {
    try {
      const { rows: [r] } = await db.query<{ n: number }>(DIGEST_DONE_TODAY_SQL, [day]);
      report.done_today = r?.n ?? 0;
    } catch (err) {
      console.error(`[chat-digest] счёт разобранных за день не прочитан — отказ, SQLSTATE ${sqlstate(err)}`);
    }
  }
  return report;
}
