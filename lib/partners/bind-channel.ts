/**
 * Записать мессенджер оператора по ссылке привязки (lib/partners/channel-link).
 *
 * Куда пишется. Источник истины для доставки — колонки партнёра:
 * `partners.telegram_chat_id` и `partners.max_chat_id`. Их читают уведомление
 * о брони (`notifyNewBooking` через `reachForPartner`) и перепись
 * operator-reach. Telegram ДОПОЛНИТЕЛЬНО зеркалится в
 * `contacts->>'telegram_chat_id'`: этот ключ до сих пор читают раздача горячих
 * лидов, напоминания по лидам и приёмник оплат оператора (последний — §7, «не
 * трогать»). Без зеркала привязка доходила бы до броней и не доходила бы до
 * лидов — половина механизма, выглядящая целой. Колонка contacts на проде
 * по умолчанию `[]` (baseline), а не `{}`: `[] || объект` даёт МАССИВ и ключ
 * не пишет, поэтому пустой/NULL заменяется пустым объектом, а НЕПУСТОЙ массив не трогается —
 * потерять его содержимое хуже, чем не записать зеркало (колонка при этом
 * пишется всегда) (обзор 29.09). Читатели ключа перечислены в
 * сторожe `tests/unit/partner-channel-link.test.ts`, список может только
 * сокращаться.
 *
 * Перепривязка разрешена — ссылку выдаёт администратор, — но не молча: о ней
 * узнают администратор и ПРЕЖНИЙ чат. Утёкшая ссылка иначе тихо увела бы имена
 * и телефоны туристов в чужой чат.
 *
 * Исходы (§4.0): записано / партнёра нет / база не ответила. Отказ пишется в
 * лог с SQLSTATE и возвращается вызывающему — «не смог» не выдаётся за
 * «привязано».
 */

import { pool } from '@/lib/db-pool';
import { telegramService } from '@/lib/notifications/telegram';
import { maxSendDm } from '@/lib/notifications/max-channel';
import { escapeHtml } from '@/lib/text/escape-html';
import { partnerTokenFromStart, verifyPartnerLinkToken } from '@/lib/partners/channel-link';
import { rentalCabinetBar } from '@/lib/rental/cabinet-bar';
import { isRentalPilotSlug, rentalPilotBoundText } from '@/lib/rental/operator-pilot';
import { operatorBoundText, operatorDeskButtons } from '@/lib/telegram/operator-desk';
import { getPublicBaseUrl } from '@/lib/config';
import { GUIDE_OWN_PATH } from '@/lib/partners/cabinet-links';
import { partnerMenu } from '@/lib/roles/role-menu';
import type { MenuButton } from '@/lib/roles/chat-menu';

export type PartnerChannel = 'telegram' | 'max';

export type BindResult =
  | {
      ok: true;
      partnerName: string;
      /** Название на витрине: company_name, иначе name. */
      displayName: string;
      category: string | null;
      slug: string | null;
      previousChatId: string | null;
      rebound: boolean;
      /**
       * Чат уже подключён и к другой карточке (один владелец у «Лагуны Прокат» и
       * «Лагуны Экспедиции»). `cabinetOf` — чей кабинет откроется в этом чате:
       * старшая запись, тем же порядком, что findPartnerByChat. null — этот.
       * `others` — названия других карточек на том же чате. Проверка не
       * удалась — оба пусты, а причина в логе.
       */
      cabinetOf: string | null;
      others: string[];
      /** Записанная карточка. */
      partnerId: string;
      /**
       * Есть ли у карточки свои неудалённые туры — тем же запросом, что
       * запись (EXISTS по operator_tours, черновики считаются). Решает строку
       * меню гида: «Брони» и «Мои туры» — только продавцу (`sellsOwnTours`).
       */
      sellsTours: boolean;
    }
  | { ok: false; reason: 'not_found' | 'db_error' };

const CHANNEL_LABEL: Record<PartnerChannel, string> = { telegram: 'Telegram', max: 'MAX' };

/**
 * `ownerUserId` — кто открыл ссылку (id пользователя MAX или Telegram), только
 * из личного диалога и заверенного апдейта; иначе null, и прежний владелец
 * остаётся. По нему администратор заводит вход на сайт через мессенджер (1336).
 */
export async function bindPartnerChannel(
  partnerId: string,
  channel: PartnerChannel,
  chatId: number,
  ownerUserId: number | null = null,
): Promise<BindResult> {
  if (!Number.isSafeInteger(chatId)) return { ok: false, reason: 'db_error' };
  const owner = ownerUserId !== null && Number.isSafeInteger(ownerUserId) && ownerUserId > 0 ? String(ownerUserId) : null;

  // Прежнее значение читается тем же запросом, что пишет, — между чтением и
  // записью нет окна, в котором «прежний чат» успел бы стать другим.
  const sql = channel === 'telegram'
    ? `UPDATE partners p
          SET telegram_chat_id = $1::bigint,
              contacts = CASE
                           -- Непустой массив не трогаем совсем: «массив || объект»
                           -- ДОПИСЫВАЕТ элемент, и ключ по-прежнему не читается.
                           WHEN jsonb_typeof(p.contacts) = 'array' AND p.contacts <> '[]'::jsonb THEN p.contacts
                           ELSE (CASE WHEN jsonb_typeof(p.contacts) = 'object' THEN p.contacts ELSE '{}'::jsonb END)
                                || jsonb_build_object('telegram_chat_id', $1::text)
                         END,
              telegram_owner_user_id = COALESCE($3::bigint, p.telegram_owner_user_id),
              updated_at = NOW()
         FROM (SELECT id, telegram_chat_id::text AS old FROM partners WHERE id = $2::uuid) prev
        WHERE p.id = prev.id
        RETURNING p.name,
                  COALESCE(NULLIF(btrim(p.company_name), ''), p.name) AS display_name,
                  p.category, p.slug, prev.old AS previous,
                  EXISTS (SELECT 1 FROM operator_tours own
                           WHERE own.operator_id = p.id AND own.deleted_at IS NULL) AS sells_tours`
    : `UPDATE partners p
          SET max_chat_id = $1::bigint,
              max_owner_user_id = COALESCE($3::bigint, p.max_owner_user_id),
              updated_at = NOW()
         FROM (SELECT id, max_chat_id::text AS old FROM partners WHERE id = $2::uuid) prev
        WHERE p.id = prev.id
        RETURNING p.name,
                  COALESCE(NULLIF(btrim(p.company_name), ''), p.name) AS display_name,
                  p.category, p.slug, prev.old AS previous,
                  EXISTS (SELECT 1 FROM operator_tours own
                           WHERE own.operator_id = p.id AND own.deleted_at IS NULL) AS sells_tours`;

  type BoundRow = {
    name: string; display_name: string | null; category: string | null; slug: string | null; previous: string | null;
    sells_tours: boolean | null;
  };
  let row: BoundRow | undefined;
  try {
    ({ rows: [row] } = await pool.query<BoundRow>(sql, [String(chatId), partnerId, owner]));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(
      `[bind-channel] ${CHANNEL_LABEL[channel]} партнёра ${partnerId} не записан:`,
      e?.message ?? 'неизвестная ошибка',
      `SQLSTATE=${e?.code ?? 'нет'}`,
    );
    return { ok: false, reason: 'db_error' };
  }
  if (!row) return { ok: false, reason: 'not_found' };

  const previous = row.previous;
  const rebound = previous !== null && previous !== String(chatId);
  const shared = await sharedChat(channel, chatId, partnerId);
  await announceBinding(channel, row.name, previous, rebound, shared, row.category);
  const slug = typeof row.slug === 'string' && row.slug.trim() !== '' ? row.slug : null;
  const displayName = typeof row.display_name === 'string' && row.display_name.trim() !== ''
    ? row.display_name
    : row.name;
  const category = typeof row.category === 'string' && row.category.trim() !== '' ? row.category : null;
  return {
    ok: true, partnerName: row.name, displayName, category, slug, previousChatId: previous, rebound,
    cabinetOf: shared.cabinetOf, others: shared.others,
    partnerId, sellsTours: row.sells_tours === true,
  };
}

/**
 * Строка меню гида под ответом на привязку: та же, что `partnerMenu` в его
 * чате (Входящие, Помощь; продавцу своих туров — ещё Брони и Мои туры).
 * null — не гид, привязка не записана или кабинет в этом чате у другой
 * карточки (`cabinetOf`): кнопки гида там отказали бы «не этот кабинет».
 * Туроператор и пилот проката получают свои кнопки отдельно.
 */
export function boundMenuRow(result: BindResult): MenuButton[] | null {
  if (!result.ok || result.category !== 'guide' || result.cabinetOf !== null) return null;
  return partnerMenu({
    partnerId: result.partnerId,
    category: 'guide',
    slug: result.slug,
    sellsTours: result.sellsTours === true,
  });
}

/**
 * Другие карточки на этом же чате. Один чат — один кабинет: findPartnerByChat
 * берёт старшую запись, и до 25.10 вторая привязка отвечала «подключён к B»,
 * хотя помощник, «Входящие» и даты в чате оставались у A (проверка каналов).
 */
async function sharedChat(
  channel: PartnerChannel,
  chatId: number,
  partnerId: string,
): Promise<{ cabinetOf: string | null; others: string[] }> {
  const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_chat_id';
  try {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT id::text AS id, COALESCE(NULLIF(btrim(company_name), ''), name) AS name
         FROM partners
        WHERE ${column} = $1::bigint
        ORDER BY created_at ASC NULLS LAST, id ASC`,
      [String(chatId)],
    );
    const others = rows.filter((r) => r.id !== partnerId).map((r) => r.name);
    const first = rows[0];
    return { cabinetOf: first && first.id !== partnerId ? first.name : null, others };
  } catch (err) {
    const e = err as { code?: string };
    console.error(`[bind-channel] другие карточки на чате ${CHANNEL_LABEL[channel]} не проверены, SQLSTATE=${e?.code ?? 'нет'}`);
    return { cabinetOf: null, others: [] };
  }
}

/** Строка об общем чате — одна для партнёра и администратора; пусто — чат только этой карточки. */
function sharedChatNote(partnerName: string, cabinetOf: string | null, others: readonly string[]): string {
  const me = escapeHtml(partnerName);
  if (cabinetOf) {
    return `Учтите: этот чат уже подключён к «${escapeHtml(cabinetOf)}», и кабинет в нём — «${escapeHtml(cabinetOf)}»: `
      + `помощник, «Входящие» и кнопки здесь работают для неё. Заявки «${me}» тоже будут приходить сюда. `
      + `Чтобы вести «${me}» отдельно, откройте ссылку в другом аккаунте.`;
  }
  if (others.length > 0) {
    return `В этом чате подключены и ${others.map((n) => `«${escapeHtml(n)}»`).join(', ')}: кабинет здесь — «${me}», `
      + 'их заявки тоже приходят сюда.';
  }
  return '';
}

/**
 * Сообщить администратору и прежнему чату. Персональных данных туристов в этих
 * сообщениях нет — только название оператора и канал. Отказ отправки не
 * отменяет привязку, но пишется в лог: «не сообщили» не равно «сообщили».
 */
async function announceBinding(
  channel: PartnerChannel,
  partnerName: string,
  previous: string | null,
  rebound: boolean,
  shared: { cabinetOf: string | null; others: string[] },
  category: string | null = null,
): Promise<void> {
  const label = CHANNEL_LABEL[channel];
  // Ссылку привязки выдают и гиду (код из кабинета, op_): «оператор» о нём —
  // неправда администратору и прежнему чату.
  const guide = category === 'guide';
  const adminChat = process.env.TELEGRAM_CHAT_ID;
  if (adminChat) {
    const name = escapeHtml(partnerName);
    const who = guide ? 'Гид' : 'Оператор';
    const head = rebound
      ? `${who} «${name}»: заявки в ${label} ПЕРЕНЕСЕНЫ в другой чат по ссылке привязки. Если перенос не согласован — выдайте ${guide ? 'гиду' : 'оператору'} новую ссылку.`
      : `${who} «${name}» подключил ${label}: заявки будут приходить туда.`;
    const note = sharedChatNote(partnerName, shared.cabinetOf, shared.others);
    const text = note ? `${head}\n\n${note}` : head;
    const res = await telegramService.sendMessage({ chatId: adminChat, text });
    if (!res.success) console.error(`[bind-channel] администратор не уведомлён о привязке: ${res.error ?? 'нет ответа'}`);
  } else {
    console.error('[bind-channel] TELEGRAM_CHAT_ID не задан — администратор о привязке не уведомлён');
  }

  if (!rebound || previous === null) return;
  const notice = `Заявки ${guide ? 'гида' : 'оператора'} «${escapeHtml(partnerName)}» больше не приходят в этот чат — их перенесли в другой по ссылке привязки. Если это сделали не вы, сообщите администратору платформы.`;
  if (channel === 'telegram') {
    const res = await telegramService.sendMessage({ chatId: previous, text: notice });
    if (!res.success) console.error(`[bind-channel] прежний Telegram-чат не уведомлён: ${res.error ?? 'нет ответа'}`);
  } else {
    const res = await maxSendDm(previous, notice);
    if (!res.ok) console.error(`[bind-channel] прежний MAX-чат не уведомлён: ${res.error ?? 'нет ответа'}`);
  }
}

/** Текст ответа в чат, где нажали «Старт». */
export function bindReplyText(channel: PartnerChannel, result: BindResult): string {
  if (!result.ok) {
    return result.reason === 'not_found'
      ? 'Оператор по этой ссылке не найден. Попросите у администратора платформы новую ссылку.'
      : 'Не удалось сохранить привязку — база не ответила. Попробуйте открыть ссылку ещё раз через несколько минут.';
  }
  const tail = channel === 'telegram'
    ? 'Сюда будут приходить номера заявок и ссылки в кабинет. Имя и телефон туриста по закону о персональных данных приходят только в MAX — подключите и его, если ещё нет.'
    : 'Сюда будут приходить заявки туристов с именем и телефоном.';
  return `Готово: ${CHANNEL_LABEL[channel]} подключён к оператору «${escapeHtml(result.partnerName)}». ${tail}`;
}

/**
 * Текст гиду после записи чата (29.10). До этого гид слышал «подключён к
 * оператору». Называет только то, что в чате есть: личные сообщения о бронях,
 * заявках и запросах мест его собственных туров и о сообщениях туристов,
 * кнопки строки меню под этим же ответом (`boundMenuRow`: продавцу своих
 * туров — ещё «Брони» и «Мои туры») и где подтверждают бронь: продавцу —
 * кнопками под «Бронями» (вопрос, затем «Да», lib/bookings/chat-owner-action)
 * или в кабинете, остальным — в кабинете. Строки нет (кабинет чата у другой
 * карточки) — кнопок текст не обещает.
 */
export function guideBoundText(name: string, channel: PartnerChannel, menu: readonly MenuButton[] | null = null): string {
  const contacts = channel === 'max'
    ? 'Имя и телефон туриста приходят в этот чат.'
    : 'Имя и телефон туриста в этот чат не приходят — по закону о персональных данных их принимает MAX.';
  const lines = [
    `Вы подключены как гид «${escapeHtml(name)}».`,
    'Сюда будут приходить брони, заявки и запросы мест на туры, которые вы продаёте сами, и сообщения туристов из чата платформы.',
    contacts,
  ];
  if (menu && menu.length > 0) {
    lines.push('', `Кнопки под этим сообщением: ${menu.map((b) => `«${b.text}»`).join(', ')}. «Помощь» — что каждая показывает.`);
  }
  const buttons = menu?.some((b) => b.payload.endsWith(':bk')) === true;
  lines.push(buttons
    ? `Подтвердить или отклонить бронь — кнопками под «Бронями» (бот спросит, бронь меняется после «Да») или в кабинете, раздел «Свои туры»: ${getPublicBaseUrl()}${GUIDE_OWN_PATH}`
    : `Подтвердить или отклонить бронь — в кабинете, раздел «Свои туры»: ${getPublicBaseUrl()}${GUIDE_OWN_PATH}`);
  return lines.join('\n');
}

/**
 * Текст после записи чата. Туроператор (не пилот проката) узнаёт свою роль
 * словами кабинета, гид — своими. Пилот — своим текстом в MAX. Остальные —
 * прежней фразой.
 */
export function channelBoundText(channel: PartnerChannel, result: BindResult): string {
  const base = result.ok && result.category === 'operator' && !isRentalPilotSlug(result.slug)
    ? operatorBoundText(result.displayName || result.partnerName, channel)
    : result.ok && result.category === 'guide'
      ? guideBoundText(result.displayName || result.partnerName, channel, boundMenuRow(result))
      : result.ok && isRentalPilotSlug(result.slug) && channel === 'max'
        ? rentalPilotBoundText(result.partnerName)
        : bindReplyText(channel, result);
  if (!result.ok) return base;
  const note = sharedChatNote(result.displayName || result.partnerName, result.cabinetOf, result.others);
  return note ? `${base}\n\n${note}` : base;
}

/** Текст для недействительной ссылки. */
export function badLinkReplyText(reason: 'malformed' | 'bad_signature' | 'expired' | 'no_secret'): string {
  if (reason === 'expired') return 'Ссылка для подключения устарела (действует 72 часа). Попросите у администратора платформы новую.';
  if (reason === 'no_secret') return 'Подключение сейчас недоступно — на платформе не настроена проверка ссылок. Администратор уже может это видеть в логе.';
  return 'Ссылка для подключения недействительна. Попросите у администратора платформы новую.';
}

/**
 * Обработать аргумент /start, если это ссылка привязки оператора.
 *
 * Возвращает true, если аргумент был ссылкой привязки (ответ человеку уже
 * отправлен — удачный или с причиной отказа), и false, если это не наша
 * ссылка и обработчик идёт дальше. Разбор, проверка подписи и запись живут
 * здесь одной цепочкой; обработчик канала решает только, ЧЬЁ это чат, — по
 * заверенному источнику апдейта, а не по полю тела.
 */
export async function handlePartnerStart(
  arg: string,
  channel: PartnerChannel,
  chatId: number,
  reply: (
    text: string,
    buttons?: ReadonlyArray<ReadonlyArray<{ text: string; payload: string }>>,
  ) => Promise<unknown>,
  /** Кто открыл ссылку — только из личного диалога (см. bindPartnerChannel). */
  ownerUserId: number | null = null,
): Promise<boolean> {
  const token = partnerTokenFromStart(arg);
  if (token === null) return false;
  const check = verifyPartnerLinkToken(token);
  if (!check.ok) {
    console.error(`[bind-channel] ссылка привязки оператора (${CHANNEL_LABEL[channel]}) отклонена: ${check.reason}`);
    await reply(badLinkReplyText(check.reason));
    return true;
  }
  const bound = await bindPartnerChannel(check.partnerId, channel, chatId, ownerUserId);
  const pilot = bound.ok && isRentalPilotSlug(bound.slug);
  const desk = bound.ok && bound.category === 'operator' && !pilot;
  const text = channelBoundText(channel, bound);
  const guideRow = boundMenuRow(bound);
  const buttons = pilot
    ? [rentalCabinetBar()]
    : desk && channel === 'max'
      ? operatorDeskButtons()
      : guideRow
        ? [guideRow]
        : undefined;
  await reply(text, buttons);
  return true;
}
