/**
 * Сторож полноты удаления аккаунта (152-ФЗ, ст. 21; #2327).
 *
 * eraseUser (lib/account/erase.ts) обещает человеку: «персональные данные
 * стёрты». Обещание держится, только пока список шагов покрывает каждую
 * таблицу, где лежат его ПД, а то, что остаётся, названо ему словами. Новая
 * таблица с телефоном и ссылкой на аккаунт без нового шага — ровно то, с чего
 * начался #2327: участники группы, документы туриста и телефон заказа мест
 * пережили удаление, хотя ответ уже говорил «стёрты».
 *
 * Как судится:
 *   - ПЕРЕПИСЬ — по артефактам схемы (baseline + миграции после границы
 *     снимка, tests/helpers/pd-census.ts): таблица, связанная с человеком
 *     (колонка-ссылка user_id/tourist_id/…_user_id, внешний ключ на users или
 *     на таблицу, которую стирает eraseUser), и с колонками ПД — телефон,
 *     почта, имя, документы, медицинское, ник и id в мессенджере, IP,
 *     заметки, координаты;
 *   - ВТОРАЯ ПЕРЕПИСЬ — по той же связи: свободный текст и jsonb, которых
 *     признак ПД по имени не видит. С неё начался третий круг #2327:
 *     переписка с Кузьмичом в chat_sessions.messages и спутники в
 *     route_registrations.group_members пережили удаление, а ответ говорил
 *     «стёрты». Признак — род колонки (любая json/jsonb) и имя свободного
 *     текста (сообщение, содержимое, запрос, комментарий, описание,
 *     пожелания, подпись);
 *   - ШАГИ — вызовом eraseUser на записывающей заглушке, а не чтением её
 *     исходника: стёрто то, что функция шлёт базе;
 *   - таблица стёрта, если её строки удаляются (DELETE) или UPDATE переписывает
 *     КАЖДУЮ её колонку ПД. Иначе — запись в ERASE_KEEP с причиной: таблица
 *     целиком (`table`) или одна колонка (`table.column`).
 *   - ОТВЕТ — вызовом findRemainingData и erasureMessage: «стёрты» только при
 *     пустом остатке; иначе названо, что осталось, чего не проверить и что к
 *     аккаунту не привязано.
 *
 * Чего не видят обе: текстовой колонки с именем не из списка свободного
 * текста (тема обращения, адрес подачи) — где eraseUser её всё же стирает,
 * это проверяет pg-тест, а не перепись; и таблиц без ссылки на человека —
 * их называет ответ (ERASE_UNLINKED), и список ведётся руками.
 *
 * ERASE_KEEP самоустаревает: запись о таблице, которой больше нет в переписи,
 * или о том, что уже стирается, — красная; ERASE_UNLINKED — о таблице,
 * которой нет в схеме. Что разбор схемы по файлам ничего не теряет (и род
 * колонки тоже), проверяет pg-тест: обе переписи с information_schema
 * настоящей базы обязаны совпасть (tests/integration/tourist-cabinet.pg.test.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  isFreeTextColumn, isPdColumn, kindOfTypeText, personDataCensus, recordDetachSteps, recordEraseSteps, schemaFromRepo,
  type CensusRow, type EraseStep, type ParsedSchema,
} from '../helpers/pd-census';
import {
  ERASE_DETACH_ONLY, ERASE_KEEP, ERASE_STEP_LEAVES, ERASE_UNLINKED, HAND_TITLE_KINDS, PARTNER_MESSENGER_NOT_HIS,
  UNPROVEN_CARD_KEEP, UNPROVEN_CRM_CARDS, UNPROVEN_CRM_PARTNERS,
  eraseUser, erasureMessage, findRemainingData, findEraseBlockers, unprovenCrmSentence,
  type EraseQueryable,
} from '@/lib/account/erase';
import { EVENT_KINDS } from '@/lib/crm/event-kinds';
import { REQUISITES } from '@/lib/legal/requisites';

let steps: EraseStep[] = [];
let census = new Map<string, CensusRow>();
let schema: ParsedSchema = { columns: new Map(), foreignKeys: [] };

beforeAll(async () => {
  steps = await recordEraseSteps();
  schema = schemaFromRepo();
  census = personDataCensus(schema, new Set(steps.map((s) => s.table)));
});

/** Колонки обеих переписей: ПД по имени и свободный текст с jsonb. */
const judged = (row: CensusRow) => [...row.pd, ...row.free];

/** Колонки таблицы из обеих переписей, которые шаги eraseUser оставляют нетронутыми. */
function untouched(table: string, row: CensusRow): string[] {
  const own = steps.filter((s) => s.table === table);
  if (own.some((s) => s.kind === 'delete')) return [];
  const set = new Set(own.flatMap((s) => [...s.set]));
  return judged(row).filter((c) => !set.has(c));
}

describe('удаление аккаунта: каждая таблица с ПД человека стирается или хранится с причиной', () => {
  it('перепись видит таблицы, ради которых заведена (иначе сторож зеленеет впустую)', () => {
    // Ноль при нулевом входе — отказ, а не успех (§4.0): сломанный разбор
    // схемы дал бы пустую перепись и зелёный сторож.
    for (const t of ['users', 'operator_bookings', 'tourist_profiles', 'tourist_documents',
      'booking_group_members', 'transfer_seat_bookings', 'route_registrations', 'crm_contacts',
      'operator_client_notes', 'tg_conversations', 'user_ai_memory']) {
      expect(census.has(t), `перепись не видит ${t}`).toBe(true);
    }
    expect(census.get('booking_group_members')?.links).toContain('booking_id->operator_bookings');
    expect(census.get('tourist_documents')?.pd).toContain('document_number');
    // Находки ревью #2327: ник в Telegram, заметки о клиенте, IP согласия,
    // id чата — всё это ПД человека, и перепись обязана их видеть.
    expect(census.get('operator_client_notes')?.pd).toContain('telegram');
    expect(census.get('crm_contacts')?.pd).toEqual(expect.arrayContaining(['notes', 'pd_consent_ip']));
    expect(census.get('operator_bookings')?.pd).toContain('pd_consent_ip');
    expect(census.get('tg_conversations')?.pd).toEqual(expect.arrayContaining(['chat_id', 'user_name']));
    expect(census.get('users')?.pd).toEqual(expect.arrayContaining(
      ['telegram_username', 'telegram_id', 'telegram_chat_id', 'max_user_id', 'max_username', 'pd_consent_ip']));
    // Третий круг: координаты человека — по имени, переписка и спутники —
    // второй переписью; реплики веб-чата — через ключ на его сессию.
    expect(census.get('route_registrations')?.pd).toEqual(expect.arrayContaining(['last_position_lat', 'last_position_lng']));
    expect(census.get('route_registrations')?.free).toEqual(expect.arrayContaining(['group_members', 'route_description']));
    expect(census.get('chat_sessions')?.free).toEqual(expect.arrayContaining(['messages', 'context']));
    expect(census.get('chat_messages')?.links).toContain('session_id->chat_sessions');
    expect(census.get('chat_messages')?.free).toContain('content');
    expect(census.get('support_tickets')?.free).toContain('messages');
    expect(census.get('sos_events')?.pd).toEqual(expect.arrayContaining(['lat', 'lng']));
    expect(steps.length).toBeGreaterThan(10);
  });

  it('признак ПД по имени колонки: мессенджер, IP и заметки — да; счётчики и названия — нет', () => {
    for (const c of ['telegram', 'client_telegram', 'telegram_username', 'telegram_handle', 'max_username',
      'chat_id', 'tourist_chat_id', 'max_chat_id', 'telegram_id', 'max_user_id',
      'ip', 'ip_address', 'pd_consent_ip', 'visitor_ip', 'notes', 'note', 'admin_notes', 'guest_notes']) {
      expect(isPdColumn(c), c).toBe(true);
    }
    // Координаты человека — где он был.
    for (const c of ['lat', 'lng', 'last_position_lat', 'last_position_lng', 'reporter_lat', 'latitude', 'longitude']) {
      expect(isPdColumn(c), c).toBe(true);
    }
    // Похожие имена, которые ПД не являются: потолки, счётчики, id сообщений.
    for (const c of ['max_participants', 'budget_max', 'max_message_id', 'max_advance_booking_days',
      'telegram_group_url', 'description', 'zip', 'shipping', 'tip_amount',
      'platform', 'latency_ms', 'longest_streak', 'flat_fee']) {
      expect(isPdColumn(c), c).toBe(false);
    }
  });

  it('вторая перепись: свободный текст по имени и любая jsonb — да; статусы и суммы — нет', () => {
    // Род колонки — из текста типа в DDL, как его пишут baseline и миграции.
    for (const t of ['jsonb', 'JSONB NOT NULL DEFAULT \'{}\'::jsonb', 'json', 'jsonb[]', '"jsonb"']) {
      expect(kindOfTypeText(t), t).toBe('json');
    }
    for (const t of ['text', 'TEXT[]', 'character varying(255)', 'numeric(9,6)', 'jsonish_domain']) {
      expect(kindOfTypeText(t), t).toBe('other');
    }
    for (const c of ['messages', 'message', 'content', 'payload', 'query', 'answer', 'text', 'body', 'details',
      'feedback', 'caption', 'comment', 'comments', 'review_comment', 'description', 'route_description',
      'special_requests', 'group_members', 'reason', 'cancellation_reason', 'decline_reason', 'refund_reason']) {
      expect(isFreeTextColumn(c, 'other'), c).toBe(true);
    }
    // Любая jsonb — в переписи, как бы ни звалась: о человеке в ней может быть что угодно.
    for (const c of ['context', 'party', 'metadata', 'widget_origin']) expect(isFreeTextColumn(c, 'json'), c).toBe(true);
    for (const c of ['status', 'currency', 'booking_status', 'title', 'message_type', 'error_count', 'reasoning_tokens']) {
      expect(isFreeTextColumn(c, 'other'), c).toBe(false);
    }
  });

  it('вторая перепись: переписка с Кузьмичом, спутники и описание маршрута стираются шагом, а не ERASE_KEEP', () => {
    // Ровно находки ревью #2327: признак по имени их не видел, ответ говорил «стёрты».
    for (const [table, col] of [
      ['chat_sessions', 'messages'], ['chat_sessions', 'interests_encrypted'], ['chat_messages', 'content'],
      ['route_registrations', 'group_members'], ['route_registrations', 'route_description'],
      ['route_registrations', 'last_position_lat'], ['route_registrations', 'last_position_lng'],
    ] as const) {
      const row = census.get(table);
      expect(row, table).toBeDefined();
      if (col !== 'interests_encrypted') expect(judged(row!), `${table}.${col} в переписи`).toContain(col);
      expect(ERASE_KEEP[table], `${table} не в ERASE_KEEP`).toBeUndefined();
      expect(ERASE_KEEP[`${table}.${col}`], `${table}.${col} не в ERASE_KEEP`).toBeUndefined();
      const own = steps.filter((st) => st.table === table);
      expect(own.some((st) => st.kind === 'delete' || st.set.has(col)), `${table}.${col} стирается шагом`).toBe(true);
    }
  });

  it('причина отмены и отказа — свободный текст о человеке: перепись её видит, шаг её стирает (#2327, четвёртый круг)', () => {
    // Ревью: «Турист в больнице с переломом» переживало удаление в
    // operator_bookings.cancellation_reason, а ответ говорил «стёрты».
    for (const [table, col] of [
      ['operator_bookings', 'cancellation_reason'], ['accommodation_bookings', 'cancellation_reason'],
      ['transfer_seat_bookings', 'decline_reason'], ['transfers', 'cancellation_reason'],
    ] as const) {
      const row = census.get(table);
      expect(row?.free, `${table}.${col} в переписи`).toContain(col);
      expect(ERASE_KEEP[`${table}.${col}`], `${table}.${col} не в ERASE_KEEP`).toBeUndefined();
      expect(steps.some((st) => st.table === table && st.set.has(col)), `${table}.${col} стирается шагом`).toBe(true);
    }
  });

  it('копия причины отклонения его брони в журнале действия кнопкой из чата гида стирается шагом по его броням (ревью 29.10)', () => {
    // partner_chat_actions ссылается на бронь текстом (subject_id) без
    // внешнего ключа, и перепись по связи её не видит — а «Отклонить» в чате
    // кладёт туда причину для туриста дословно. Шаг по чатам самого
    // удаляемого (DELETE) этой копии не касается: чат — гида. Что шаг пишет
    // в строки, проверяет pg-тест (tourist-cabinet, «причина отклонения его
    // брони кнопкой в чате гида»).
    expect(ERASE_KEEP['partner_chat_actions.reason']).toBeUndefined();
    const own = steps.filter((st) => st.table === 'partner_chat_actions');
    expect(own.some((st) => st.kind === 'update' && st.set.has('reason')), 'partner_chat_actions.reason стирается шагом').toBe(true);
    // Брони находит та же дорога, что шаг operator_bookings, — и после него.
    const order = steps.map((st) => `${st.table}:${st.kind}`);
    expect(order.indexOf('operator_bookings:update')).toBeLessThan(order.indexOf('partner_chat_actions:update'));
  });

  it('журнал смены статуса его броней: комментарий (там и причина отмены словами туриста) стирается шагом, а не хранится «заметкой оператора» (#2327, пятый круг)', () => {
    // Ревью: cancelBooking писал причину туриста («у меня ковид») в
    // booking_logs.comment, а ERASE_KEEP называл её «рабочей заметкой
    // оператора». Что шаг пишет в строки, проверяет pg-тест на настоящей базе.
    expect(census.get('booking_logs')?.free).toContain('comment');
    expect(census.get('booking_logs')?.links).toContain('booking_id->operator_bookings');
    expect(ERASE_KEEP.booking_logs).toBeUndefined();
    expect(ERASE_KEEP['booking_logs.comment']).toBeUndefined();
    expect(steps.some((st) => st.table === 'booking_logs' && st.set.has('comment')), 'booking_logs.comment стирается шагом').toBe(true);
    // Брони находит та же дорога, что шаг operator_bookings, — и после него.
    const order = steps.map((st) => st.table);
    expect(order.indexOf('operator_bookings')).toBeLessThan(order.indexOf('booking_logs'));
  });

  it('у каждой таблицы обеих переписей все колонки стираются шагом eraseUser или стоят в ERASE_KEEP', () => {
    const missing: string[] = [];
    for (const [table, row] of census) {
      if (ERASE_KEEP[table]) continue;
      const left = untouched(table, row).filter((c) => !ERASE_KEEP[`${table}.${c}`]);
      if (left.length > 0) {
        missing.push(`${table}: ${left.join(', ')} (связь: ${row.links.join(', ')})`);
      }
    }
    expect(
      missing,
      'ПД человека переживают удаление аккаунта. Добавь шаг в eraseUser '
      + '(lib/account/erase.ts) или запись в ERASE_KEEP с причиной, почему это хранится',
    ).toEqual([]);
  });

  it('ERASE_KEEP самоустаревает: таблица пропала из переписи или уже стирается — запись убрать', () => {
    const stale: string[] = [];
    for (const key of Object.keys(ERASE_KEEP)) {
      const [table, column] = key.split('.');
      const row = census.get(table);
      if (!row) { stale.push(`${key}: таблицы нет в переписи (нет в схеме, нет ПД или нет связи с человеком)`); continue; }
      const left = untouched(table, row);
      if (column === undefined) {
        if (steps.some((s) => s.table === table)) {
          stale.push(`${key}: eraseUser теперь трогает таблицу — оставшиеся колонки вносить по одной (${left.join(', ') || 'все стёрты'})`);
        }
      } else if (!judged(row).includes(column)) {
        stale.push(`${key}: колонки нет ни среди ПД таблицы, ни среди её свободного текста и jsonb`);
      } else if (!left.includes(column)) {
        stale.push(`${key}: колонка уже стирается`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('у каждой записи ERASE_KEEP есть причина, а у оставшегося у человека — слова для него и счёт', () => {
    const thin = Object.entries(ERASE_KEEP).filter(([, e]) => e.reason.trim().length < 40).map(([k]) => k);
    expect(thin).toEqual([]);
    for (const [key, e] of Object.entries(ERASE_KEEP)) {
      if (!e.remains) continue;
      expect(e.remains.category.trim().length, `${key}: категория`).toBeGreaterThan(10);
      expect(e.remains.why.trim().length, `${key}: почему`).toBeGreaterThan(10);
      if (e.remains.countSql !== null) {
        // Счёт — по ссылке на человека, параметром, не склейкой.
        expect(e.remains.countSql, key).toMatch(/\$1\b/);
        expect(e.remains.countSql, key).not.toMatch(/\$[2-9]/);
      }
    }
  });

  it('переписка с Кузьмичом и сессии MAX стираются ДО шага users: после него ключа к ним нет', () => {
    const order = steps.map((s) => s.table);
    const users = order.indexOf('users');
    expect(users).toBeGreaterThan(-1);
    for (const t of ['tg_conversations', 'max_login_sessions', 'chat_messages', 'chat_sessions']) {
      expect(order.indexOf(t), t).toBeGreaterThan(-1);
      expect(order.indexOf(t), `${t} после users`).toBeLessThan(users);
    }
    // Реплики — до сессий: после удаления сессий их уже не найти по ним.
    expect(order.indexOf('chat_messages')).toBeLessThan(order.indexOf('chat_sessions'));
    // Журнал доставки — до самих уведомлений, по той же причине.
    expect(order.indexOf('notification_log')).toBeLessThan(order.indexOf('notifications'));
    // users обнуляет именно те ключи, по которым шаги выше находят строки.
    const u = steps.find((s) => s.table === 'users')!;
    for (const c of ['telegram_id', 'telegram_chat_id', 'max_user_id']) expect(u.set.has(c), c).toBe(true);
  });

  it('ERASE_UNLINKED самоустаревает: каждая его таблица есть в схеме, у записи есть причина', () => {
    const stale: string[] = [];
    for (const [key, e] of Object.entries(ERASE_UNLINKED)) {
      expect(e.reason.trim().length, `${key}: причина`).toBeGreaterThan(40);
      expect(e.category.trim().length, `${key}: категория`).toBeGreaterThan(10);
      for (const t of e.tables) if (!schema.columns.has(t)) stale.push(`${key}: таблицы ${t} нет в схеме`);
    }
    expect(stale).toEqual([]);
  });

  it('запросы мест в туре: подключённые к его Telegram стираются до шага users, остальные названы непривязанными', () => {
    // Ревью четвёртого круга: запрос, к которому он привязал свой Telegram
    // кнопкой «Старт», — его (та же связь, что у брони из Telegram), а ответ
    // говорил «найти их по вам нельзя». Сам SQL — на настоящей базе в pg-тесте.
    const order = steps.map((s) => s.table);
    const seat = steps.find((s) => s.table === 'tour_seat_requests');
    expect(seat?.kind).toBe('update');
    for (const c of ['tourist_name', 'tourist_phone', 'tourist_chat_id', 'pd_consent_ip']) expect(seat?.set.has(c), c).toBe(true);
    // Ключ к запросу (id в Telegram) живёт в users; брони запросов шаг
    // operator_bookings находит по чату запроса — значит, раньше, чем чат стёрт.
    expect(order.indexOf('tour_seat_requests')).toBeLessThan(order.indexOf('users'));
    expect(order.indexOf('operator_bookings')).toBeLessThan(order.indexOf('tour_seat_requests'));
    expect(ERASE_KEEP.tour_seat_requests).toBeUndefined();
    expect(ERASE_UNLINKED.seat_requests?.tables).toEqual(['tour_seat_requests']);
    expect(ERASE_UNLINKED.seat_requests?.category).toContain('не подключённые к вашему Telegram');
  });

  it('журнал доставки тревог контроля выхода: адресат — телефон или почта контакта, перепись его видит, шаг стирает ДО регистрации (#2327, ревью круга 10)', () => {
    // Сторож пишет в recipient телефон или почту экстренного контакта
    // (checkin-watchdog, recordNotification), а признак ПД знал только
    // recipient_name — журнал переживал удаление, ответ говорил «стёрты».
    expect(isPdColumn('recipient')).toBe(true);
    const row = census.get('route_registration_notifications');
    expect(row?.links).toContain('registration_id->route_registrations');
    expect(row?.pd).toContain('recipient');
    expect(ERASE_KEEP.route_registration_notifications).toBeUndefined();
    const step = steps.find((st) => st.table === 'route_registration_notifications');
    expect(step?.kind).toBe('update');
    expect([...step!.set].sort()).toEqual(['error_message', 'recipient']);
    // Адреса, по которым узнаётся текст отказа, берутся из регистрации.
    const order = steps.map((st) => st.table);
    expect(order.indexOf('route_registration_notifications')).toBeLessThan(order.indexOf('route_registrations'));
  });

  it('каналы карточки партнёра: шаг снимает только их и стоит до tg_conversations и users; туры, машины и заявки карточки его данными не считаются (#2327, ревью круга 10)', () => {
    const order = steps.map((st) => st.table);
    const p = steps.find((st) => st.table === 'partners');
    expect(p?.kind).toBe('update');
    expect([...p!.set].sort()).toEqual([
      'contacts', 'max_chat_id', 'max_owner_user_id', 'telegram_chat_id', 'telegram_owner_user_id', 'updated_at',
    ]);
    // Ключи — его id в users и диалог MAX в tg_conversations.
    expect(order.indexOf('partners')).toBeLessThan(order.indexOf('tg_conversations'));
    expect(order.indexOf('partners')).toBeLessThan(order.indexOf('users'));
    // Карточка — не его строка: ссылающиеся на неё таблицы перепись по этой связи не берёт.
    for (const t of ['leads', 'transfer_fleet_vehicles', 'transfer_charter_prices']) expect(census.has(t), t).toBe(false);
  });

  it('id в мессенджере в таблице, ссылающейся на карточку партнёра, — шаг, перепись, «не привязано» или причина (ревью этапа C 22.10)', () => {
    // Перепись по ссылке на карточку таблицу не берёт (ERASE_DETACH_ONLY), а
    // id чата в ней может быть его диалогом: предложения «открыть даты»
    // хранили id его диалога MAX и после удаления аккаунта — шаг partners
    // снимал канал с карточки, а копия оставалась навсегда.
    const MESSENGER = /(?:^|_)chat_id$|^(?:telegram|tg|max|vk)_(?:user_)?id$/;
    const touched = new Set(steps.map((st) => st.table));
    const unlinked = new Set(Object.values(ERASE_UNLINKED).flatMap((u) => [...u.tables]));
    const linked = [...new Set(schema.foreignKeys
      .filter((fk) => ERASE_DETACH_ONLY[fk.refTable] !== undefined && fk.table !== fk.refTable)
      .map((fk) => fk.table))]
      .filter((t) => [...(schema.columns.get(t)?.keys() ?? [])].some((c) => MESSENGER.test(c)));
    // Ноль при нулевом входе — отказ (§4.0): разбор схемы обязан видеть таблицу, ради которой сторож заведён.
    expect(linked).toContain('operator_chat_date_proposals');
    const unanswered = linked.filter((t) => !touched.has(t) && !census.has(t) && !unlinked.has(t)
      && PARTNER_MESSENGER_NOT_HIS[t] === undefined);
    expect(unanswered, 'шаг eraseUser, или запись в PARTNER_MESSENGER_NOT_HIS с причиной').toEqual([]);
    // Самоустаревание: у таблицы появился шаг или её нет в схеме — запись убрать.
    for (const [t, why] of Object.entries(PARTNER_MESSENGER_NOT_HIS)) {
      expect(linked, `${t}: в схеме нет такой связи — запись убрать`).toContain(t);
      expect(touched.has(t), `${t}: шаг есть — запись убрать`).toBe(false);
      expect(why.trim().length, t).toBeGreaterThan(40);
    }
    // Предложения дат: удаляются по его id в MAX ДО шагов, где живут ключи к диалогу.
    const order = steps.map((st) => st.table);
    expect(steps.find((st) => st.table === 'operator_chat_date_proposals')?.kind).toBe('delete');
    expect(order.indexOf('operator_chat_date_proposals')).toBeLessThan(order.indexOf('tg_conversations'));
    expect(order.indexOf('operator_chat_date_proposals')).toBeLessThan(order.indexOf('users'));
  });

  it('ERASE_DETACH_ONLY и ERASE_STEP_LEAVES самоустаревают: у каждой записи есть шаг по таблице и причина, счёт — по ссылке на человека', () => {
    const touched = new Set(steps.map((st) => st.table));
    expect(Object.keys(ERASE_DETACH_ONLY).length).toBeGreaterThan(0);
    for (const [t, why] of Object.entries(ERASE_DETACH_ONLY)) {
      expect(touched.has(t), `${t}: шага нет — запись убрать`).toBe(true);
      expect(why.trim().length, t).toBeGreaterThan(40);
    }
    expect(Object.keys(ERASE_STEP_LEAVES).length).toBeGreaterThan(0);
    for (const [key, r] of Object.entries(ERASE_STEP_LEAVES)) {
      expect(touched.has(key.split('.')[0]), `${key}: шага нет — запись убрать`).toBe(true);
      expect(r.category.trim().length, key).toBeGreaterThan(10);
      expect(r.why.trim().length, key).toBeGreaterThan(10);
      expect(r.countSql, key).toMatch(/\$1\b/);
      expect(r.countSql, key).not.toMatch(/\$[2-9]/);
    }
  });

  /** Всё, что eraseUser шлёт базе, по порядку — на заглушке, которая ничего не находит. */
  async function sentByErase(): Promise<string[]> {
    const sent: string[] = [];
    await eraseUser({
      query: async (text: string) => { sent.push(text); return { rows: [], rowCount: 0 } as never; },
    }, '00000000-0000-4000-8000-000000000000', 'account_deleted');
    return sent;
  }
  const isLock = (q: string) => /^\s*SELECT\b[\s\S]*FROM crm_contacts\b[\s\S]*FOR UPDATE/i.test(q);

  it('CRM: карточки, которые не доказанно его, находятся до шагов его источников — пока его брони из Telegram находятся по users', async () => {
    // detachFromUnprovenCrmContacts находит его брони из Telegram по
    // users.telegram_id (HIS_BOOKINGS); шаг operator_bookings снимает метку,
    // а шаг users — сам ключ.
    const sent = await sentByErase();
    const read = sent.findIndex(isLock);
    const bookings = sent.findIndex((q) => /^\s*UPDATE operator_bookings\b/.test(q));
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(bookings);
    // До решения о карточках — только снятие копии 1200 из заметки (ниже).
    const before = sent.slice(0, read).filter((q) => /^\s*(UPDATE|DELETE)\b/i.test(q));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatch(/^\s*UPDATE crm_contacts SET\b[\s\S]*FROM operator_client_notes n/);
  });

  it('CRM: копия карточки оператора (миграция 1200) снимается до решения о карточках и до шага operator_client_notes — только строка Telegram в заметке, метки — нет', async () => {
    // Решение о том, его ли карточка, видит заметку: копия, оставленная до
    // решения, делала его карточку «не доказанно его» (ревью круга 10). Ключ
    // к копии — строка operator_client_notes, которую удаляет шаг ниже.
    const sent = await sentByErase();
    const strip = sent.findIndex((q) => /^\s*UPDATE crm_contacts SET\b[\s\S]*FROM operator_client_notes n/.test(q));
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(sent.findIndex(isLock));
    expect(strip).toBeLessThan(sent.findIndex((q) => /^\s*DELETE FROM operator_client_notes\b/.test(q)));
    const step = steps.find((st) => st.table === 'crm_contacts' && !st.set.has('display_name'))!;
    expect([...step.set].sort()).toEqual(['notes', 'updated_at']);
  });

  it('CRM: второй проход по карточкам, которые не доказанно его, — перед лентой и после всех шагов его источников', async () => {
    // Склейка, пришедшая во время стирания, запирает строку источника до
    // записи: шаг источника ждёт её коммита, и второй проход её связь видит.
    const sent = await sentByErase();
    const locks = sent.map((q, i) => (isLock(q) ? i : -1)).filter((i) => i >= 0);
    expect(locks).toHaveLength(2);
    const at = (re: RegExp) => sent.findIndex((q) => re.test(q));
    for (const src of [/^\s*UPDATE operator_bookings\b/, /^\s*UPDATE gear_rentals\b/, /^\s*UPDATE accommodation_bookings\b/,
      /^\s*UPDATE transfer_seat_bookings\b/]) {
      expect(at(src), String(src)).toBeLessThan(locks[1]);
    }
    expect(locks[1]).toBeLessThan(at(/^\s*UPDATE crm_events SET payload\b/));
  });

  it('CRM: лента стирается до карточки, карточка теряет ссылку на аккаунт; задач в его карточке нет — и шага нет', () => {
    // Карточку находят и по ссылке на аккаунт (HIS_CRM_CONTACTS), а шаг
    // crm_contacts её снимает: события после него не нашлись бы.
    const order = steps.map((s) => s.table);
    const card = steps.findIndex((s) => s.table === 'crm_contacts' && s.set.has('display_name'));
    expect(order.indexOf('crm_events')).toBeGreaterThan(-1);
    expect(order.indexOf('crm_events')).toBeLessThan(card);
    expect(order.indexOf('operator_bookings')).toBeLessThan(order.indexOf('crm_events'));
    // Карточка с задачей доказанно его не бывает (PROVEN_HIS_CARD): шаг,
    // который их стирал, никогда бы ничего не нашёл — мёртвый шаг выглядел бы
    // как стирание заметок партнёра, которого нет (pg-тест (а'') держит, что
    // задачи такой карточки целы).
    expect(order).not.toContain('crm_tasks');
    const c = steps[card];
    for (const col of ['user_id', 'display_name', 'phone', 'phone_e164', 'email', 'email_norm', 'notes', 'tags']) {
      expect(c.set.has(col), col).toBe(true);
    }
  });
});

/** Заглушка базы для счёта оставшегося: ответ по подстроке SQL. */
function fakeDb(answer: (sql: string) => number | Error): EraseQueryable & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    query: async (text: string) => {
      sent.push(text);
      if (/SAVEPOINT/.test(text)) return { rows: [] };
      const a = answer(text);
      if (a instanceof Error) throw a;
      return { rows: [{ n: a }] };
    },
  };
}

describe('ответ на удаление не говорит больше, чем сделано', () => {
  it('ничего не осталось — «стёрты», и названо только то, что к аккаунту не привязано', async () => {
    const rem = await findRemainingData(fakeDb(() => 0), 'u1');
    expect(rem.kept).toEqual([]);
    expect(rem.unchecked).toEqual([]);
    expect(rem.unlinked.map((u) => u.category)).toEqual([
      'наблюдения о тропах, отправленные открытой формой',
      'разговоры с Кузьмичом без входа в аккаунт — на сайте и в окне чата на сайтах партнёров, '
        + 'в том числе начатые до входа и не продолженные после него',
      'запросы мест в туре, оставленные без входа в аккаунт и не подключённые к вашему Telegram',
      'брони, которые Кузьмич принял в MAX, и брони из Telegram, если Telegram не привязан к аккаунту',
      'контроли маршрута, поставленные в чате Кузьмича в MAX или формой регистрации маршрута без входа в аккаунт',
      'заявки на подбор тура, на машину и на жильё, оставленные формой или в чате, и переписка по ним',
    ]);
    const msg = erasureMessage(rem);
    expect(msg).toMatch(/^Аккаунт удалён, персональные данные стёрты\./);
    expect(msg).toContain('Запросы мест в туре, оставленные без входа в аккаунт и не подключённые к вашему Telegram: '
      + 'к аккаунту они не привязаны, найти их по вам нельзя, это удаление их не затронуло.');
    expect(msg).toContain('Разговоры с Кузьмичом без входа в аккаунт — на сайте и в окне чата на сайтах партнёров, '
      + 'в том числе начатые до входа и не продолженные после него: к аккаунту они не привязаны, найти их по вам нельзя; '
      + 'не привязаны и прежние разговоры, продолженные после входа до того, как платформа стала их привязывать, '
      + 'это удаление их не затронуло.');
    expect(msg).toContain('Брони, которые Кузьмич принял в MAX, и брони из Telegram, если Telegram не привязан к аккаунту: '
      + 'к аккаунту они не привязаны, найти их по вам нельзя, это удаление их не затронуло.');
    // Контроль без аккаунта (чат MAX, форма без входа) — что это, почему не
    // стёрт и как попросить (ревью круга 10, пункт 3).
    expect(msg).toContain('Контроли маршрута, поставленные в чате Кузьмича в MAX или формой регистрации маршрута без входа '
      + 'в аккаунт: к аккаунту они не привязаны, найти их по вам нельзя (удалить закрытые можно по обращению на '
      + `${REQUISITES.emailPrivacy} — назовите номер телефона, который указали в контроле), это удаление их не затронуло.`);
    expect(msg).not.toContain('Осталось');
  });

  it('осталась карточка партнёра — ответ называет её и причину, «персональные данные стёрты» не говорит', async () => {
    const card = ERASE_KEEP['partners.name'].remains!;
    const rem = await findRemainingData(fakeDb((sql) => (sql === card.countSql ? 1 : 0)), 'u1');
    expect(rem.kept).toEqual([{
      category: 'карточка партнёра, скрытая с витрины',
      why: card.why,
      count: 1,
    }]);
    const msg = erasureMessage(rem);
    expect(msg).not.toContain('персональные данные стёрты');
    expect(msg).toContain('Осталось: карточка партнёра, скрытая с витрины — на неё ссылаются туры и брони');
  });

  it('чат карточки партнёра, который не доказанно его, назван в ответе, и первая фраза не говорит «привязки стёрты» без оговорки (#2327, ревью круга 10)', async () => {
    const leaves = ERASE_STEP_LEAVES['partners.channels'];
    const rem = await findRemainingData(fakeDb((sql) => (sql === leaves.countSql ? 1 : 0)), 'u1');
    expect(rem.kept).toEqual([{ category: leaves.category, why: leaves.why, count: 1 }]);
    const msg = erasureMessage(rem);
    expect(msg).toMatch(/^Аккаунт удалён: документы стёрты; имя, телефон, почта и привязки Telegram и MAX — везде, кроме названного ниже\./);
    expect(msg).toContain(`Осталось: ${leaves.category} — ${leaves.why}.`);
  });

  it('одна категория из нескольких таблиц называется один раз, счёт суммируется', async () => {
    const rem = await findRemainingData(fakeDb((sql) => (/agent_commissions|commission_payouts/.test(sql) ? 2 : 0)), 'u1');
    expect(rem.kept).toEqual([{ category: 'начисления и выплаты агентской комиссии', why: expect.any(String), count: 4 }]);
  });

  it('счёт не выполнился — «не удалось проверить», а не «стёрты», и стирание не откатывается', async () => {
    const db = fakeDb((sql) => (/FROM security_blocks/.test(sql)
      ? Object.assign(new Error('relation "security_blocks" does not exist'), { code: '42P01' }) : 0));
    const rem = await findRemainingData(db, 'u1');
    expect(rem.unchecked.map((u) => u.category)).toEqual(['блокировка за нарушение правил']);
    // Откат только до точки сохранения этого счёта, не всей транзакции.
    expect(db.sent).toContain('ROLLBACK TO SAVEPOINT erase_remains');
    expect(db.sent).not.toContain('ROLLBACK');
    const msg = erasureMessage(rem);
    expect(msg).not.toContain('персональные данные стёрты');
    expect(msg).toContain('Не удалось проверить, осталось ли: блокировка за нарушение правил.');
  });

  it('заказ мест в машине на будущую поездку — отказ удаления, как у предстоящей брони', async () => {
    const db: EraseQueryable = {
      query: async () => ({ rows: [{ upcoming_booking: false, upcoming_transfer_seat: true, active_route_registration: false }] }),
    };
    expect(await findEraseBlockers(db, 'u1')).toEqual(['upcoming_transfer_seat']);
  });

  it('запрос мест, ждущий ответа оператора, — отказ удаления; SQL — на настоящей базе в pg-тесте', async () => {
    const db: EraseQueryable = {
      query: async () => ({ rows: [{ upcoming_booking: false, pending_seat_request: true, upcoming_transfer_seat: false,
        active_route_registration: false, partner_live_business: false }] }),
    };
    expect(await findEraseBlockers(db, 'u1')).toEqual(['pending_seat_request']);
  });

  it('его незакрытая аренда снаряжения и живая бронь жилья — отказы удаления; SQL — на настоящей базе в pg-тесте', async () => {
    const answer = (row: Record<string, boolean>): EraseQueryable => ({ query: async () => ({ rows: [row] }) });
    expect(await findEraseBlockers(answer({ upcoming_gear_rental: true }), 'u1')).toEqual(['upcoming_gear_rental']);
    // Срок прошёл, возврат не отмечен — отказа нет (круг 9): это решение
    // проката, и такого исхода проверка не знает; SQL — в pg-тесте.
    expect(await findEraseBlockers(answer({ unreturned_gear_rental: true }), 'u1')).toEqual([]);
    expect(await findEraseBlockers(answer({ upcoming_stay: true }), 'u1')).toEqual(['upcoming_stay']);
    expect(await findEraseBlockers(answer({ upcoming_gear_rental: true, upcoming_stay: true }), 'u1'))
      .toEqual(['upcoming_gear_rental', 'upcoming_stay']);
  });

  it('проверка живых дел не выполнилась — не «можно»: отказ базы и пустой ответ бросают, а не дают пустой список', async () => {
    // §4.0: «не смог проверить» ≠ «живых дел нет». Роут ловит бросок и
    // отвечает 500 «не удалось», ничего не стерев.
    const failing: EraseQueryable = {
      query: async () => { throw Object.assign(new Error('relation "gear_rentals" does not exist'), { code: '42P01' }); },
    };
    await expect(findEraseBlockers(failing, 'u1')).rejects.toThrow();
    const empty: EraseQueryable = { query: async () => ({ rows: [] }) };
    await expect(findEraseBlockers(empty, 'u1')).rejects.toThrow();
  });

  it('владелец партнёра с живым делом — отказ удаления; SQL — на настоящей базе в pg-тесте', async () => {
    const db: EraseQueryable = {
      query: async () => ({ rows: [{ upcoming_booking: false, upcoming_transfer_seat: false,
        active_route_registration: false, partner_live_business: true }] }),
    };
    expect(await findEraseBlockers(db, 'u1')).toEqual(['partner_live_business']);
  });
});

describe('карточка CRM, которая не доказанно его: ответ — правда без угадывания (#2327, круг 9)', () => {
  it('нет таких карточек — нет и строки; есть — сколько у скольких партнёров, «могли быть вашими», куда написать', async () => {
    expect(unprovenCrmSentence({ cards: 0, partners: 0 })).toBeNull();
    const none = await findRemainingData(fakeDb(() => 0), 'u1', { [UNPROVEN_CRM_CARDS]: 0, [UNPROVEN_CRM_PARTNERS]: 0 });
    expect(erasureMessage(none)).toMatch(/^Аккаунт удалён, персональные данные стёрты\./);

    const rem = await findRemainingData(fakeDb(() => 0), 'u1', { [UNPROVEN_CRM_CARDS]: 3, [UNPROVEN_CRM_PARTNERS]: 2 });
    expect(rem.crm).toEqual({ cards: 3, partners: 2 });
    expect(rem.kept).toEqual([]);
    const msg = erasureMessage(rem);
    expect(msg).not.toContain('персональные данные стёрты');
    expect(msg).toMatch(/^Аккаунт удалён: документы стёрты; имя, телефон, почта и привязки Telegram и MAX — везде, кроме названного ниже\./);
    expect(msg).toContain('У 2 партнёров остались карточки клиентов, где были и ваши заявки. Имя, телефон, почта, адрес, с '
      + 'которого дано согласие, и записи партнёра о клиенте (заметки, метки, задачи, отметки о звонках, встречах и '
      + 'выполненных задачах) в них могли быть вашими или о вас — по общему '
      + 'номеру телефона или почте мы не можем отличить вас от другого клиента, поэтому чужое не стираем. Ваши брони, '
      + 'аренды и заказы мест от них отвязаны; заявки, оставленные формой или в чате, к аккаунту не привязаны, и если они '
      + `были в них, то там и остались. Чтобы удалить их, напишите на ${REQUISITES.emailPrivacy} и укажите номер телефона `
      + 'и почту, с которыми бронировали: администратор платформы найдёт карточки по ним, сверит с вами и сотрёт в них имя, '
      + 'телефон, почту и записи партнёра. Сами заявки это не стирает: имя и телефон, записанные в заявке, остаются у партнёра.');
    // Ревью круга 10: «Ваши заявки от неё отвязаны» обещало больше, чем
    // сделано, — заявка из формы к аккаунту не привязана и из карточки не
    // уходит; а стирание по обращению не трогает самих заявок.
    expect(msg).not.toMatch(/Ваши заявки от (неё|них) отвязаны/);
    // Ничего из того, что код не доказывает: ни «снято», ни «там другой клиент».
    for (const claim of [/(имя|номер|почт)[^.]*(снят|убран)/i, /номер другого клиента/i, /записан другой клиент/i]) {
      expect(msg).not.toMatch(claim);
    }
  });

  it('число партнёров и карточек — по-русски: «у 1 партнёра», «у 21 партнёра», «у 11 партнёров»; одна карточка — «осталась», «в ней»', () => {
    expect(unprovenCrmSentence({ cards: 1, partners: 1 }))
      .toMatch(/^У 1 партнёра осталась карточка клиента, где были и ваши заявки\. Имя, телефон, почта, [^(]*\([^)]*\) в ней могли быть вашими/);
    expect(unprovenCrmSentence({ cards: 1, partners: 1 })).toContain('Ваши брони, аренды и заказы мест от неё отвязаны; '
      + 'заявки, оставленные формой или в чате, к аккаунту не привязаны, и если они были в ней, то там и остались. Чтобы удалить её,');
    expect(unprovenCrmSentence({ cards: 5, partners: 1 })).toMatch(/^У 1 партнёра остались карточки клиентов/);
    expect(unprovenCrmSentence({ cards: 21, partners: 21 })).toMatch(/^У 21 партнёра остались/);
    expect(unprovenCrmSentence({ cards: 11, partners: 11 })).toMatch(/^У 11 партнёров остались/);
    expect(unprovenCrmSentence({ cards: 4, partners: 2 })).toMatch(/^У 2 партнёров остались/);
  });

  it('ответ называет всё, что остаётся в такой карточке (UNPROVEN_CARD_KEEP): новая запись без слова для человека — красная', () => {
    // Слово ответа на каждую запись: ответ уже того, что остаётся, — человек
    // не узнает, что медицинская заметка о нём может лежать у партнёра, и не
    // попросит её стереть (§4.0: называть то, что осталось).
    const WORD: Readonly<Record<string, string>> = {
      'crm_contacts.display_name': 'Имя',
      'crm_contacts.phone': 'телефон',
      'crm_contacts.phone_e164': 'телефон',
      'crm_contacts.email': 'почта',
      'crm_contacts.email_norm': 'почта',
      'crm_contacts.pd_consent_ip': 'адрес, с которого дано согласие',
      'crm_contacts.notes': 'заметки',
      crm_tasks: 'задачи',
      'crm_events.note': 'заметки',
      'crm_events.call': 'звонках',
      'crm_events.meeting': 'встречах',
      'crm_events.task_done': 'выполненных задачах',
    };
    const s = unprovenCrmSentence({ cards: 2, partners: 1 })!;
    for (const key of Object.keys(UNPROVEN_CARD_KEEP)) {
      expect(WORD[key], `${key}: нет слова для ответа человеку`).toBeDefined();
      expect(s, key).toContain(WORD[key]);
    }
    // Метки переписью ПД не видны (массив — не колонка с именем ПД), но остаются тоже.
    expect(s).toContain('метки');
  });

  it('куда написать — почта по вопросам ПД из реквизитов, а не кабинет: после удаления кабинета нет', () => {
    const s = unprovenCrmSentence({ cards: 1, partners: 1 })!;
    expect(s).toContain(REQUISITES.emailPrivacy);
    expect(s).not.toMatch(/кабинет|раздел «Поддержка»/);
  });
});

describe('карточка CRM, которая не доказанно его: что из неё уходит и что остаётся (UNPROVEN_CARD_KEEP, круг 9)', () => {
  let detach: EraseStep[] = [];
  beforeAll(async () => { detach = await recordDetachSteps(); });
  const CRM_TABLES = ['crm_contacts', 'crm_tasks', 'crm_events', 'crm_contact_links'];

  it('в самой карточке путь переписывает только ссылку на аккаунт: имя, телефон, почта, согласие, заметки и метки — нет', () => {
    const card = detach.filter((st) => st.table === 'crm_contacts');
    expect(card).toHaveLength(1);
    expect([...card[0].set].sort()).toEqual(['updated_at', 'user_id']);
  });

  it('его связи удаляются, его события уходят из ленты; обезличивает их шаг crm_events, который идёт после', () => {
    expect(detach.some((st) => st.table === 'crm_contact_links' && st.kind === 'delete')).toBe(true);
    const ev = detach.find((st) => st.table === 'crm_events');
    expect(ev?.kind).toBe('update');
    expect([...ev!.set]).toEqual(['contact_id']);
    // Шаг crm_events — после пути и стирает текст событий: то, что путь увёл из
    // ленты, он находит по источнику (pg-тест (б): причина отмены снята).
    const order = steps.map((st) => st.table);
    expect(order.indexOf('crm_events')).toBeGreaterThan(-1);
    expect(steps.find((st) => st.table === 'crm_events')?.set.has('payload')).toBe(true);
  });

  it('колонка ПД карточки, которую путь не переписывает, и таблица CRM, которую он не трогает, стоят в UNPROVEN_CARD_KEEP', () => {
    const row = census.get('crm_contacts');
    expect(row, 'перепись видит crm_contacts').toBeDefined();
    const cardUpdate = detach.find((st) => st.table === 'crm_contacts')!;
    const left = judged(row!).filter((c) => !cardUpdate.set.has(c));
    expect(left.length).toBeGreaterThan(0);
    expect(left.filter((c) => !UNPROVEN_CARD_KEEP[`crm_contacts.${c}`]),
      'карточка, которая не доказанно его, оставляет колонку ПД без причины — добавь её в UNPROVEN_CARD_KEEP').toEqual([]);
    const untouchedTables = CRM_TABLES.filter((t) => census.has(t) && !detach.some((st) => st.table === t));
    expect(untouchedTables.filter((t) => !UNPROVEN_CARD_KEEP[t])).toEqual([]);
  });

  it('UNPROVEN_CARD_KEEP самоустаревает: путь уже переписывает колонку или трогает таблицу — запись убрать; причина не пустая', () => {
    const row = census.get('crm_contacts')!;
    const cardUpdate = detach.find((st) => st.table === 'crm_contacts')!;
    const stale: string[] = [];
    for (const [key, reason] of Object.entries(UNPROVEN_CARD_KEEP)) {
      expect(reason.trim().length, key).toBeGreaterThan(40);
      const [table, column] = key.split('.');
      if (table === 'crm_events' && column !== undefined) {
        // Вид событий ленты: что такие строки переживают путь нетронутыми,
        // судит pg-тест (tourist-cabinet.pg.test.ts, построчно по видам);
        // здесь — что вид есть в словаре ленты и его заголовок пишет человек.
        if (!(EVENT_KINDS as readonly string[]).includes(column)) stale.push(`${key}: такого вида событий нет`);
        else if (!HAND_TITLE_KINDS.includes(column as (typeof EVENT_KINDS)[number])) stale.push(`${key}: вид пишет код, а не человек`);
      } else if (column === undefined) {
        if (detach.some((st) => st.table === table)) stale.push(`${key}: путь теперь трогает таблицу`);
      } else if (table !== 'crm_contacts' || !judged(row).includes(column)) {
        stale.push(`${key}: колонки нет среди ПД карточки`);
      } else if (cardUpdate.set.has(column)) {
        stale.push(`${key}: путь уже переписывает колонку`);
      }
    }
    expect(stale).toEqual([]);
  });
});
