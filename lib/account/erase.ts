/**
 * Удаление аккаунта и отзыв согласия на обработку ПД (152-ФЗ, ст. 9 и 21).
 *
 * Согласие — условие аккаунта (регистрация без него невозможна), поэтому
 * отзыв согласия и удаление — одна операция: персональные данные стираются
 * сразу, а не «через 30 дней» (прежний POST /api/user/delete только ставил
 * отметку, и исполнителя у неё не было).
 *
 * Связанные записи не удаляются, а обезличиваются: заявка, отзыв или
 * регистрация маршрута остаются у оператора и в статистике, но без имени,
 * телефона и почты. Строки пользователя в users не удаляются — на неё
 * ссылаются десятки таблиц; вместо этого она обезличена и выключена.
 *
 * Отказ — пока есть живое дело: предстоящая заявка (new / confirmed /
 * pending_payment, дата не прошла), запрос мест в туре, на который оператор
 * ещё не ответил, заказ мест в машине на поездку, которая ещё не состоялась,
 * аренда снаряжения, срок которой не кончился (заявка, на которую прокат
 * не ответил, — не дольше 48 часов), живая бронь жилья (до заезда и после него — с разными
 * советами), открытый контроль маршрута — регистрация без отметки о
 * возвращении, какой бы ни была дата, — и закрытый меньше
 * TRIP_WATCH_CLOSURE_HOLD_HOURS назад, если сторож мог по нему писать
 * контакту: отбой уходит по тем адресам, которые стирает удаление; или
 * возврат денег по его отменённой брони, который администратор ещё не
 * отметил (переводит он вручную, по контактам брони). Стереть телефон человека, которого оператор,
 * перевозчик, прокат или хозяин жилья ждёт завтра (или по которому оператор
 * вот-вот заведёт бронь), или контакт, по которому МЧС поднимет тревогу, —
 * сломать чужую работу. Отказ и владельцу карточки партнёра, через
 * которую к нему идут заявки туристов: карточка на витрине или с окном чата на
 * его сайте, туры, жильё или прокат на витрине, предстоящие брони, заявки на
 * жильё, заказы мест в его машинах на будущие поездки и незакрытые аренды
 * снаряжения. Заявки с именами и телефонами уходят
 * в мессенджеры партнёра и после удаления аккаунта шли бы человеку, который с
 * платформой простился. Снять карточку — решение владельца платформы.
 *
 * Брони человека — не только по аккаунту: бронь, которую Кузьмич принял в
 * Telegram до привязки аккаунта, лежит без user_id с меткой канала, а бронь,
 * которую завёл запрос мест, подключённый к его Telegram, — без user_id и без
 * метки (см. HIS_BOOKINGS). Шаг operator_bookings привязывает такие брони к
 * аккаунту и стирает, отказ держит предстоящие (своим словом: отменить такую
 * бронь сам он не может — upcoming_unlinked_booking).
 * Карточка клиента в CRM партнёра, заведённая из такой брони или из его
 * аренды снаряжения (её карточка всегда без user_id), тоже его, если в ней
 * нет чужих записей и записей партнёра (см. PROVEN_HIS_CARD).
 *
 * Что стирается кроме строк самого человека:
 *   - участники группы его броней (booking_group_members): имена, телефоны,
 *     паспорта, медицинское и экстренные контакты спутников ввёл он сам;
 *   - его заказы мест в машине (transfer_seat_bookings) — телефон,
 *     комментарий и причина отказа перевозчика; живых среди них нет, их
 *     держит отказ выше;
 *   - его запросы мест в туре, подключённые к его Telegram
 *     (tour_seat_requests): имя, телефон и чат; живых среди них нет;
 *   - причина отмены его брони тура и жилья (её пишет оператор, хозяин жилья
 *     или он сам: «турист в больнице») становится нейтральной подписью — и в
 *     брони, и в журнале смены статуса (booking_logs), где прочие комментарии
 *     к его броням тоже заменяются подписью, и в журнале действия кнопкой из
 *     чата гида (partner_chat_actions.reason); в ленте CRM — снимается из
 *     событий его броней;
 *   - медицинское и аллергии в подписанном отказе (booking_waivers) и
 *     контакты его заявки в операторы (operator_applications);
 *   - свободный текст в его собственных заказах (пожелания, комментарии,
 *     заметки оператора о брони) и адрес, с которого дано согласие;
 *   - заметки о нём как о клиенте: карточка оператора (operator_client_notes,
 *     там же его ник в Telegram) удаляется, в его карточке CRM (crm_contacts) —
 *     имя, телефон и почта стираются, ссылка на аккаунт снимается. Его
 *     карточка — доказанно его по столбцам базы, а не по имени или номеру
 *     (PROVEN_HIS_CARD): не ручная, без чужого аккаунта, каждая её связь — его
 *     бронь, аренда или заказ, и партнёр в ней ничего не записывал сам
 *     (заметки, метки, задачи, касания, переименование). Строка «Telegram: …»,
 *     которую миграция 1200 перенесла в заметку его карточки из карточки
 *     оператора о нём, — его, и снимается до решения (STRIP_TELEGRAM_COPY).
 *     Из карточки, где есть чужая запись
 *     (заявка, бронь другого аккаунта, клиент агента) или запись партнёра,
 *     уходят его связи, события и ссылка на его аккаунт, а имя, телефон,
 *     почта, заметки, метки, задачи и касания остаются: чьи и о ком они — о
 *     нём или о другом клиенте с тем же номером, — доказать нечем, и ответ
 *     говорит это и куда написать (detachFromUnprovenCrmContacts,
 *     UNPROVEN_CARD_KEEP); стирает такую карточку по его обращению
 *     администратор (eraseCrmContactOnRequest);
 *     память Кузьмича о его вкусах (user_ai_memory) удаляется;
 *   - менеджер в команде оператора (operator_members) снимается с команды,
 *     его чаты для уведомлений стираются — рассылка с ПД туристов не должна
 *     идти в мессенджер человека, удалившего аккаунт;
 *   - переписка с Кузьмичом в Telegram и MAX (tg_conversations) — по его
 *     id в мессенджере, ДО шага users: после него ключа, по которому её
 *     найти, больше нет; так же — веб-чат и прежний Telegram в chat_sessions
 *     с репликами chat_messages (по user_id и по 'tg_<id>');
 *   - каналы уведомлений его карточки партнёра (partners.telegram_chat_id,
 *     max_chat_id и зеркало contacts.telegram_chat_id), доказанно его по
 *     столбцам: его id в Telegram или MAX, или диалог MAX, где он писал
 *     Кузьмичу; чужой канал карточки (чат команды) остаётся и называется в
 *     ответе (ERASE_STEP_LEAVES); предложения «открыть даты» из его диалога
 *     MAX (operator_chat_date_proposals), действия кнопкой из его чата
 *     кабинета (partner_chat_actions) и коды привязки мессенджера, которыми
 *     этот канал заводили (messenger_bind_codes), удаляются тем же ключом;
 *   - спутники, описание маршрута и последняя точка в его прошедших
 *     регистрациях маршрута, адресат в журнале доставки тревог по ним
 *     (телефон и почта экстренного контакта) и текст отказа доставки, где
 *     эти адреса названы; текст сигнала SOS; переписка обращений в
 *     поддержку; его сообщения операторам; планы поездки, уведомления,
 *     метка чата в брони, причины и комментарии в событиях его броней в CRM
 *     партнёра, комментарий к оценке ответа Кузьмича, точка, откуда он отправил
 *     наблюдение о месте;
 *   - документы туриста (tourist_documents) и список желаний
 *     (tourist_wishlist) — удаляются до анкеты: документы ссылаются на неё без
 *     внешнего ключа (миграция 903) и остались бы без хозяина вместе с
 *     номерами документов.
 *
 * Что НЕ стирается и почему:
 *   - файл документа в хранилище. `file_url` — адрес, который прислал сам
 *     клиент (`z.string().url()` в /api/tourist/documents), а не ключ нашей
 *     заливки: формы загрузки документа на платформе нет, и чей объект лежит
 *     по этому адресу, не проверить. Удалить по нему объект — рискнуть чужим
 *     файлом (снимком тура, чужим документом). Строка с адресом удаляется,
 *     объект, если он наш, остаётся ничьим; найти такие можно только сверкой
 *     хранилища с базой, и это отдельная работа (#2327).
 *   - то, что стоит в ERASE_KEEP ниже, — каждая запись с причиной. Что из
 *     этого осталось у конкретного человека, считает findRemainingData, и
 *     ответ на удаление называет это словами, а не говорит «стёрто всё»;
 *   - то, что к аккаунту не привязано вовсе (ERASE_UNLINKED): разговоры с
 *     Кузьмичом без входа, заявки из форм, брони из MAX, запросы мест, не
 *     подключённые к его Telegram, контроли маршрута из чата MAX и формы без
 *     входа. Ответ называет и их.
 *
 * Сторожа: tests/integration/tourist-cabinet.pg.test.ts (удаление на
 * настоящем PostgreSQL, ответ на обоих исходах, отказ владельцу партнёра),
 * tests/unit/account-erase-coverage.test.ts (каждая колонка ПД человека и
 * каждая колонка свободного текста или jsonb в таблицах, связанных с ним,
 * стирается здесь или стоит в ERASE_KEEP).
 */
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { publicGearSql } from '@/lib/gear/moderation';
import { holdsGearSql } from '@/lib/gear/availability';
import { EVENT_KIND_LABELS, TOUCH_KINDS, type EventKind } from '@/lib/crm/event-kinds';
import { REQUISITES } from '@/lib/legal/requisites';
import { ERASED_NAME } from '@/lib/account/erased-name';
import { CANCELLED_STATUS_PARAM, cancelledBookingSql } from '@/lib/payments/release-eligibility';

export { ERASED_NAME };

export interface EraseQueryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Слово, которое человек вводит для подтверждения удаления. */
export const ERASE_PHRASE = 'УДАЛИТЬ';

/** Строковый литерал SQL из подписи кода (не из ввода человека). */
const sqlTextLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

export type EraseBlocker =
  | 'upcoming_booking' | 'upcoming_unlinked_booking' | 'pending_seat_request'
  | 'requested_transfer_seat' | 'upcoming_transfer_seat'
  | 'upcoming_gear_rental' | 'upcoming_stay' | 'ongoing_stay' | 'active_route_registration'
  | 'recent_route_registration' | 'refund_pending' | 'partner_live_business';

/**
 * Его запрос мест в туре (tour_seat_requests). Запрос оставляют без входа —
 * формой, в чате или через MCP, — и ссылки на аккаунт у него нет. Связь с ним
 * даёт его же кнопка «Старт» со страницы статуса (bindTouristChat в
 * lib/seat-requests/service.ts): reply_channel = 'telegram', tourist_chat_id —
 * id личного чата с ботом, то есть его id в Telegram. MAX так не сверить:
 * id диалога MAX в users не хранится (запрос из MAX назван в ERASE_UNLINKED).
 * Ключ живёт только в users.telegram_id — работает лишь ДО шага users.
 */
const HIS_SEAT_REQUEST = (alias: string) => `${alias}.reply_channel = 'telegram'
            AND ${alias}.tourist_chat_id = (SELECT telegram_id FROM users WHERE id = $1)`;

/**
 * Брони человека — один подзапрос на отказ, шаги стирания и счёт оставшегося.
 * Три дороги:
 *  - по аккаунту (user_id);
 *  - бронь, которую Кузьмич принял в Telegram до привязки аккаунта: user_id
 *    пуст, а метка канала metadata.tg_chat_id — его id в Telegram
 *    (createBooking в lib/kuzmich/core; resolvePlatformUserId находит аккаунт,
 *    только когда telegram_id уже привязан). Платформа сама считает такие
 *    брони его: «ситуация туриста» Кузьмича ищет их по той же метке
 *    (loadUserSituation). Метку MAX (platform = 'max') с telegram_id не
 *    сверять: id Telegram и MAX — разные пространства чисел, а id диалога MAX
 *    в users не хранится (брони из MAX названы в ERASE_UNLINKED);
 *  - бронь, которую завёл его запрос мест (HIS_SEAT_REQUEST): ответ оператора
 *    «Есть места» зовёт reserveBooking без userId и без метки канала, и
 *    связь с человеком — только tour_seat_requests.booking_id.
 * Ключ второй и третьей дороги живёт только в users.telegram_id, поэтому они
 * работают лишь ДО шага users. Шаг operator_bookings привязывает такие брони
 * к аккаунту (user_id = $1), снимая метку, — после него их находит первая
 * дорога: и следующие шаги, и счёт оставшегося после шага users. Бронь,
 * записанная на другой аккаунт, второй и третьей дорогой не берётся.
 */
const HIS_BOOKINGS = `SELECT id FROM operator_bookings
      WHERE user_id = $1
         OR (user_id IS NULL
             AND COALESCE(metadata->>'platform', 'tg') <> 'max'
             AND metadata->>'tg_chat_id' = (SELECT telegram_id::text FROM users WHERE id = $1))
         OR (user_id IS NULL
             AND id IN (SELECT hs.booking_id FROM tour_seat_requests hs
                         WHERE hs.booking_id IS NOT NULL AND ${HIS_SEAT_REQUEST('hs')}))`;

/** Живая заявка на тур: тот же предикат у брони туриста и у броней на туры партнёра. */
const LIVE_BOOKING = (alias: string) => `${alias}.deleted_at IS NULL
            AND ${alias}.booking_status IN ('new', 'confirmed', 'pending_payment')
            AND COALESCE(${alias}.end_date, ${alias}.booking_date) >= CURRENT_DATE`;

/**
 * Незакрытая аренда снаряжения позиции партнёра: срок не прошёл, или
 * снаряжение выдано и не возвращено (active, overdue — оно ещё у клиента,
 * какой бы ни была дата). Подтверждённая, но не выданная аренда с прошедшим
 * сроком делом не считается: снаряжение у проката. Держит владельца проката
 * (partner_live_business): закрыть аренду, отметить возврат или отказать в
 * заявке — в его же руках.
 */
const LIVE_GEAR_RENTAL = (alias: string) => `${alias}.status NOT IN ('completed', 'cancelled')
            AND (${alias}.end_date >= CURRENT_DATE OR ${alias}.status IN ('active', 'overdue'))`;

/**
 * Его аренда снаряжения, которая держит удаление: срок не кончился, и аренда
 * держит снаряжение (holdsGearSql — подтверждена, выдана, или заявка моложе
 * 48 часов). Удаление не держится бессрочно тем, что решает не он:
 *   - выданное снаряжение с прошедшим сроком (active, overdue) отмечает
 *     возвращённым только прокат (PATCH /api/gear/rentals/[id]) — ускорить
 *     это человек не может ничем, и удаление этого не ждёт;
 *   - заявка без ответа проката держит снаряжение 48 часов
 *     (lib/gear/availability) — столько же она держит и удаление: отменить
 *     её сам турист не может (переход pending → cancelled — у проката).
 */
const HIS_GEAR_HOLD = (alias: string) => `${alias}.end_date >= CURRENT_DATE AND ${holdsGearSql(alias)}`;

/**
 * Сегодня по Камчатке: даты заезда и выезда жилья — местные, и отмена брони
 * жилья судит по ним (app/api/stay/bookings/[id]/cancel — заезд позже
 * сегодняшнего по Камчатке). CURRENT_DATE сессии (на проде — не Камчатка)
 * расходился бы с ней на день.
 */
const KAMCHATKA_TODAY = `(NOW() AT TIME ZONE 'Asia/Kamchatka')::date`;

/**
 * Живая бронь жилья: ждёт ответа хозяина или подтверждена, и выезд не прошёл
 * (статусы — миграция 716: pending, confirmed, cancelled, completed, no_show).
 * Один предикат на бронь самого гостя и на брони жилья, которое он сдаёт. У
 * гостя он делится по заезду на два отказа (findEraseBlockers): до заезда
 * бронь отменяет сам гость, после — уже нет.
 */
const LIVE_STAY = (alias: string) => `${alias}.status IN ('pending', 'confirmed')
            AND ${alias}.check_out_date >= ${KAMCHATKA_TODAY}`;

/**
 * Открытый контроль выхода (docs/safety/WATCH_MANIFEST.md): регистрация без
 * отметки о возвращении. Тот же предикат, что у сторожа невозвращения
 * (app/api/cron/checkin-watchdog — completed_at IS NULL) и у контролей чата
 * (openWatchesForChat): пока он открыт, сторож ведёт лестницу — пишет
 * экстренному контакту и поднимает дежурного с телефоном руководителя,
 * контактом и последней точкой. Ни дата (просроченный контроль — как раз
 * тот, по которому ищут), ни «жив, задерживаюсь» (checkin_confirmed_at —
 * markTripWatchAlive лестницу не снимает, только откладывает) контроль не
 * закрывают; шаг route_registrations их бы стёр, и дежурный получил бы
 * тревогу без данных. Закрыть контроль — в руках самого человека: кнопка
 * «Я вернулся» в «Контрольном сроке» (POST /api/safety/return), поэтому
 * отказ не держит бессрочно.
 */
const OPEN_TRIP_WATCH = 'completed_at IS NULL';

/**
 * Адресаты-роли в журнале доставки тревог (route_registration_notifications.recipient):
 * дежурный и сам турист. Их пишет сторож (app/api/cron/checkin-watchdog,
 * recordNotification), по ним читают весть (announceToAlerted: дежурному —
 * 'admin', контакту — всё, что не роль) и «встревожили других»
 * (openWatchesForChat). Прочие значения — телефон или почта экстренного
 * контакта: их шаг route_registration_notifications заменяет подписью.
 */
const JOURNAL_ROLE_RECIPIENTS = ['admin', 'tourist'] as const;
const JOURNAL_ROLES_SQL = JOURNAL_ROLE_RECIPIENTS.map(sqlTextLiteral).join(', ');

/**
 * Сколько часов закрытый контроль выхода держит удаление, если сторож мог по
 * нему писать контакту (CLOSED_WATCH_MAY_ALERT).
 *
 * Отбой («вернулся, искать не нужно») уходит тем, кого встревожили, по
 * журналу доставки и Telegram контакта в регистрации (announceToAlerted,
 * lib/safety/trip-watch.ts) — ровно по тем адресам, которые стирает
 * удаление. «Я вернулся» шлёт отбой сразу, но прогон сторожа
 * (app/api/cron/checkin-watchdog), выбравший контроль ДО отметки, шлёт уже
 * начатую ступень из памяти, пишет её адресата в журнал и следом зовёт
 * announceClosure. Сотри удаление контакт в этом промежутке — отбой до
 * контакта молча не дойдёт (Telegram контакта уже стёрт), а журнал получит
 * его телефон заново, после удаления.
 *
 * Срок — от длины одного прогона сторожа: пачка до 100 дел (WATCHDOG_BATCH),
 * и на каждое при отказах каналов — до двух минут ожидания (Telegram 10 с,
 * почта 10 с, MAX 15 с, звонок дежурному 10 с на ступень и столько же на
 * отбой). Прогон, выбравший контроль до отметки, доходит до него и шлёт отбой
 * не позже чем через три с небольшим часа; четыре — с запасом. Следующий
 * прогон (сторож ходит раз в час, docs/safety/WATCH_MANIFEST.md) закрытый
 * контроль уже не берёт: его выборка — completed_at IS NULL.
 */
export const TRIP_WATCH_CLOSURE_HOLD_HOURS = 4;

/**
 * Закрытый меньше TRIP_WATCH_CLOSURE_HOLD_HOURS назад контроль, по которому
 * сторож мог писать контакту:
 *  - по нему уже уходили уведомления контакту — доставлено, адресат не роль
 *    (тот же признак, по которому announceToAlerted шлёт отбой контакту);
 *  - или прогон сторожа мог взять его до отметки и ещё не дослать: контроль
 *    закрыт после своего срока (то же выражение срока, что в выборке
 *    сторожа), или срок продлевали (ladder_reset_at — до продления он мог
 *    быть просрочен по прежнему сроку, а прежний срок не хранится).
 * Контроль, закрытый вовремя и без продлений, сторож не брал никогда — он
 * удаление не держит. Параметр $3 — TRIP_WATCH_CLOSURE_HOLD_HOURS.
 */
const CLOSED_WATCH_MAY_ALERT = (r: string) => `${r}.completed_at IS NOT NULL
            AND ${r}.completed_at > NOW() - INTERVAL '1 hour' * $3
            AND (
              EXISTS (SELECT 1 FROM route_registration_notifications rn
                       WHERE rn.registration_id = ${r}.id AND rn.status = 'sent'
                         AND rn.recipient NOT IN (${JOURNAL_ROLES_SQL}))
              OR ${r}.completed_at > COALESCE(${r}.expected_return_at, ${r}.end_date::timestamptz)
              OR ${r}.ladder_reset_at IS NOT NULL
            )`;

/**
 * Возврат денег по его отменённой брони, который ещё не отмечен: тот же
 * список, что «Ждут возврата» у администратора (app/api/admin/finance/payouts —
 * платёж HELD, бронь отменена, cancelledBookingSql), и сумма к возврату не
 * ноль (refund_due, а у отмен до 1012 — вся сумма). Технического возврата нет:
 * деньги переводит администратор вручную (§7) и связывается с туристом по
 * контактам брони — шаг operator_bookings их стирает, и в списке осталось бы
 * «Удалённый пользователь» без телефона и почты. Параметр $2 —
 * CANCELLED_STATUS_PARAM.
 */
const REFUND_PENDING = (tp: string) => `${tp}.booking_id IN (${HIS_BOOKINGS})
            AND ${tp}.status = 'HELD' AND ${tp}.refunded_at IS NULL
            AND COALESCE(${tp}.refund_due, ${tp}.retail_amount) > 0
            AND ${cancelledBookingSql(tp, 2)}`;

/**
 * Что держит удаление. Предстоящая заявка на тур — двумя отказами: бронь с
 * его аккаунтом (upcoming_booking) он отменяет сам из кабинета, а бронь без
 * аккаунта — принятая Кузьмичом в Telegram до привязки или заведённая его
 * запросом мест (HIS_BOOKINGS, вторая и третья дороги) — нет: роут отмены
 * сверяет владельца по user_id (app/api/bookings/[id]/cancel), кабинет её не
 * показывает, инструмента отмены у Кузьмича нет. Отказ
 * upcoming_unlinked_booking называет то, что исполнимо: дождаться поездки или
 * попросить оператора.
 * Запрос мест в туре, подключённый к его Telegram и ещё
 * ждущий ответа оператора: на «Есть места» бронь заводится по имени и
 * телефону из запроса (answerSeatRequest), и стёртые они сорвали бы её.
 * Его аренда снаряжения, срок которой не кончился (HIS_GEAR_HOLD), и живая
 * бронь жилья (LIVE_STAY): прокат ждёт его со снаряжением, хозяин — гостя, и
 * оба знают его по имени и телефону, которые шаг gear_rentals и шаг users
 * сотрут. Срок прошёл, а прокат не отметил возврат, — не держит: это решение
 * проката, и держать удаление бессрочно тем, чего человек изменить не может,
 * нельзя.
 * Бронь жилья — по заезду: до него (upcoming_stay) гость отменяет её сам, с
 * дня заезда (ongoing_stay) отмена закрыта (app/api/stay/bookings/[id]/cancel),
 * и отказ называет то, что исполнимо: дождаться выезда или написать в поддержку.
 * Открытый контроль маршрута (OPEN_TRIP_WATCH) — пока его ведёт сторож
 * невозвращения, телефон руководителя, контакт и последняя точка — то, с чем
 * дежурный начнёт поиск; закрыть его человек может сам («Я вернулся»).
 * Закрытый недавно, если сторож мог по нему писать контакту
 * (CLOSED_WATCH_MAY_ALERT, recent_route_registration), — пока не дошёл отбой;
 * держит не дольше TRIP_WATCH_CLOSURE_HOLD_HOURS.
 * Заказ мест в машине — двумя отказами: запрос, на который перевозчик не
 * ответил (requested_transfer_seat), он может отклонить (declineSeats берёт
 * только requested); подтверждённый (upcoming_transfer_seat) не отменяет
 * никто — ни заказчик, ни перевозчик, и совет — дождаться поездки.
 * Возврат денег по его отменённой брони, который администратор ещё не
 * отметил (REFUND_PENDING, refund_pending): переводит его администратор по
 * контактам брони, и они нужны до отметки.
 *
 * Отказ базы — не «можно»: запрос бросает, и роут отвечает «не удалось»,
 * ничего не стерев; строки без ответа тоже нет (§4.0).
 *
 * Последний пункт — владелец карточки партнёра (partners.user_id), через
 * которую к нему идут заявки туристов с именем и телефоном: в Telegram и MAX
 * партнёра (lib/partners/reach.ts — по partners.*_chat_id, не глядя на
 * users.is_active). Дорог несколько, и отказ держит каждую:
 *  - карточка на витрине (is_public) или с окном чата на сайте партнёра
 *    (widget_enabled): форма «Написать оператору» и виджет берут именно
 *    таких партнёров (app/api/leads — `widget_enabled OR is_public`), как и
 *    заявка на машину у перевозчика (lib/transfers/charter — is_public);
 *  - туры на витрине и предстоящие брони на них;
 *  - жильё на витрине, предстоящие брони жилья и заявки на жильё, даты
 *    которых не прошли (владельцу — reachForPartner, lib/notifications);
 *  - прокат: позиция снаряжения на витрине (publicGearSql — публичность
 *    карточки партнёра ей не нужна) и незакрытая аренда его позиции, срок
 *    которой не прошёл, или выданная и не возвращённая (active, overdue —
 *    снаряжение ещё у клиента, какой бы ни была дата): заявка на прокат шлёт
 *    имя и телефон клиента в мессенджер партнёра (app/api/gear/rentals,
 *    notifyNewGearRental);
 *  - заказы мест в его машинах на поездку, которая ещё не состоялась (тот же
 *    предикат, что у заказа самого туриста выше): заказчик ждёт машину, а
 *    напоминание о заказе с его именем идёт в мессенджер перевозчика
 *    (lib/crm/inbox-reminders).
 * Напоминания CRM о задачах по клиентам, которые партнёр уже знает, отказ не
 * держит: это не новые заявки с чужими контактами, а учёт самого партнёра, и
 * судьба его каналов — решение владельца платформы.
 * Удали он аккаунт — ПД туристов продолжали бы уходить человеку, который с
 * платформой простился. Снять карточку, туры, жильё и прокат с витрины или
 * стереть каналы партнёра — решение владельца платформы, а не побочный
 * эффект удаления аккаунта.
 */
export async function findEraseBlockers(db: EraseQueryable, userId: string): Promise<EraseBlocker[]> {
  const { rows } = await db.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM operator_bookings ob
          WHERE ob.user_id = $1 AND ${LIVE_BOOKING('ob')}
       ) AS upcoming_booking,
       EXISTS (
         SELECT 1 FROM operator_bookings ub
          WHERE ub.id IN (${HIS_BOOKINGS}) AND ub.user_id IS NULL AND ${LIVE_BOOKING('ub')}
       ) AS upcoming_unlinked_booking,
       EXISTS (
         SELECT 1 FROM tour_seat_requests tsr
          WHERE ${HIS_SEAT_REQUEST('tsr')}
            AND tsr.status = 'pending' AND tsr.tour_date >= CURRENT_DATE
            AND (tsr.deadline_at > NOW() OR tsr.answered_at IS NOT NULL)
       ) AS pending_seat_request,
       EXISTS (
         SELECT 1 FROM transfer_seat_bookings rsb
           JOIN transfer_trips rtt ON rtt.id = rsb.trip_id
          WHERE rsb.ordered_by_user_id = $1
            AND rsb.status = 'requested'
            AND rtt.status IN ('planned', 'confirmed')
            AND rtt.trip_date >= CURRENT_DATE
       ) AS requested_transfer_seat,
       EXISTS (
         SELECT 1 FROM transfer_seat_bookings sb
           JOIN transfer_trips tt ON tt.id = sb.trip_id
          WHERE sb.ordered_by_user_id = $1
            AND sb.status = 'confirmed'
            AND tt.status IN ('planned', 'confirmed')
            AND tt.trip_date >= CURRENT_DATE
       ) AS upcoming_transfer_seat,
       EXISTS (
         SELECT 1 FROM gear_rentals ugr
          WHERE ugr.user_id = $1 AND ${HIS_GEAR_HOLD('ugr')}
       ) AS upcoming_gear_rental,
       EXISTS (
         SELECT 1 FROM accommodation_bookings uab
          WHERE uab.user_id = $1 AND ${LIVE_STAY('uab')} AND uab.check_in_date > ${KAMCHATKA_TODAY}
       ) AS upcoming_stay,
       EXISTS (
         SELECT 1 FROM accommodation_bookings sab
          WHERE sab.user_id = $1 AND ${LIVE_STAY('sab')} AND sab.check_in_date <= ${KAMCHATKA_TODAY}
       ) AS ongoing_stay,
       EXISTS (
         SELECT 1 FROM route_registrations
          WHERE user_id = $1 AND ${OPEN_TRIP_WATCH}
       ) AS active_route_registration,
       EXISTS (
         SELECT 1 FROM route_registrations crr
          WHERE crr.user_id = $1 AND ${CLOSED_WATCH_MAY_ALERT('crr')}
       ) AS recent_route_registration,
       EXISTS (
         SELECT 1 FROM tour_payments rtp WHERE ${REFUND_PENDING('rtp')}
       ) AS refund_pending,
       EXISTS (
         SELECT 1 FROM partners p
          WHERE p.user_id = $1
            AND (
              p.is_public IS TRUE OR p.widget_enabled IS TRUE
              OR EXISTS (SELECT 1 FROM operator_tours ot WHERE ot.operator_id = p.id AND ${publicTourSql('ot')})
              OR EXISTS (
                SELECT 1 FROM operator_bookings pb
                  JOIN operator_tours pt ON pt.id = pb.operator_tour_id
                 WHERE pt.operator_id = p.id AND ${LIVE_BOOKING('pb')}
              )
              OR EXISTS (SELECT 1 FROM accommodations pa WHERE pa.partner_id = p.id AND ${publicAccommodationSql('pa')})
              OR EXISTS (
                SELECT 1 FROM accommodation_bookings ab
                  JOIN accommodations aa ON aa.id = ab.accommodation_id
                 WHERE aa.partner_id = p.id AND ${LIVE_STAY('ab')}
              )
              OR EXISTS (
                SELECT 1 FROM stay_requests sr
                  JOIN accommodations ra ON ra.id = sr.accommodation_id
                 WHERE ra.partner_id = p.id AND sr.check_out_date >= CURRENT_DATE
              )
              OR EXISTS (SELECT 1 FROM gear_items gi WHERE gi.partner_id = p.id AND ${publicGearSql('gi')})
              OR EXISTS (
                SELECT 1 FROM gear_rentals gr
                  JOIN gear_items gri ON gri.id = gr.gear_id
                 WHERE gri.partner_id = p.id AND ${LIVE_GEAR_RENTAL('gr')}
              )
              OR EXISTS (
                SELECT 1 FROM transfer_seat_bookings psb
                  JOIN transfer_trips ptt ON ptt.id = psb.trip_id
                  JOIN transfer_fleet_vehicles pv ON pv.id = ptt.vehicle_id
                 WHERE pv.partner_id = p.id
                   AND psb.status IN ('requested', 'confirmed')
                   AND ptt.status IN ('planned', 'confirmed')
                   AND ptt.trip_date >= CURRENT_DATE
              )
            )
       ) AS partner_live_business`,
    [userId, CANCELLED_STATUS_PARAM, TRIP_WATCH_CLOSURE_HOLD_HOURS],
  );
  const r = rows[0];
  // Проверка, не вернувшая строки, — не «живых дел нет», а «не смог проверить».
  if (!r) throw new Error('проверка живых дел не вернула ответа');
  const out: EraseBlocker[] = [];
  if (r.upcoming_booking) out.push('upcoming_booking');
  if (r.upcoming_unlinked_booking) out.push('upcoming_unlinked_booking');
  if (r.pending_seat_request) out.push('pending_seat_request');
  if (r.requested_transfer_seat) out.push('requested_transfer_seat');
  if (r.upcoming_transfer_seat) out.push('upcoming_transfer_seat');
  if (r.upcoming_gear_rental) out.push('upcoming_gear_rental');
  if (r.upcoming_stay) out.push('upcoming_stay');
  if (r.ongoing_stay) out.push('ongoing_stay');
  if (r.active_route_registration) out.push('active_route_registration');
  if (r.recent_route_registration) out.push('recent_route_registration');
  if (r.refund_pending) out.push('refund_pending');
  if (r.partner_live_business) out.push('partner_live_business');
  return out;
}

/**
 * Его строки-источники клиента в CRM партнёра (вид и id, как в
 * crm_contact_links и crm_events, lib/crm/source-specs): брони тура
 * (HIS_BOOKINGS — и до шага operator_bookings, и после него), брони жилья,
 * аренды снаряжения и заказы мест в машине. Каждая связана с ним столбцом
 * базы — user_id, ordered_by_user_id, метка его Telegram в брони или чат его
 * запроса мест, — а не совпадением имени, телефона или почты. Бронь из
 * Telegram до привязки аккаунта и бронь из запроса мест лежат без user_id, и
 * карточка из такой брони (reserveBooking → linkContactQuietly, крон
 * crm-contacts-sync) — тоже, с именем и телефоном из брони; аренда
 * снаряжения заводит карточку без user_id всегда (имя и телефон — из формы
 * аренды). Заявки (lead) и записная книжка агента (agent_client) столбцом к
 * аккаунту не привязаны: их здесь нет, даже если в них его имя и номер
 * (ERASE_UNLINKED, ERASE_KEEP.agent_clients).
 */
const HIS_CRM_SOURCES = `SELECT 'operator_booking'::text AS kind, id::text AS sid FROM operator_bookings WHERE id IN (${HIS_BOOKINGS})
      UNION ALL SELECT 'accommodation_booking', id::text FROM accommodation_bookings WHERE user_id = $1
      UNION ALL SELECT 'gear_rental', id::text FROM gear_rentals WHERE user_id = $1
      UNION ALL SELECT 'transfer_seat_booking', id::text FROM transfer_seat_bookings WHERE ordered_by_user_id = $1`;
const HIS_SOURCE = (alias: string) => `((${alias}.source_kind, ${alias}.source_id) IN (${HIS_CRM_SOURCES}))`;

/** Карточки, где он есть: по аккаунту или по связи с его источником. */
const CRM_CONTACTS_WITH_HIM = `SELECT id FROM crm_contacts WHERE user_id = $1
      UNION SELECT hl.contact_id FROM crm_contact_links hl WHERE ${HIS_SOURCE('hl')}`;

/**
 * Записи партнёра о клиенте карточки — то, что партнёр пишет о человеке сам,
 * а не склейка из источников: заметка и метки (updateContact, экран, Кузьмич
 * и MCP партнёра; туда же переехали заметки карточки оператора, миграция
 * 1200), задачи по клиенту (crm_tasks — завести их можно только рукой
 * партнёра, Кузьмичом или MCP по его просьбе) и касания в ленте: заметка,
 * звонок, встреча (addContactTouch) и «задача выполнена» (заголовок — текст
 * задачи, lib/crm/tasks). Заголовки смены статуса, изменения брони и
 * сообщений чата строит код из статусов и сумм (lib/crm/events, chat-events).
 */
export const HAND_TITLE_KINDS: readonly EventKind[] = [...TOUCH_KINDS, 'task_done'];
const HAND_KINDS_SQL = HAND_TITLE_KINDS.map(sqlTextLiteral).join(', ');

/**
 * Карточка CRM — его, только если это доказано столбцами базы (#2327). Имя,
 * телефон и почта этого не доказывают: по общему номеру в карточку ложатся и
 * он, и его брат, и мать, и сосед по рабочему телефону, и восемь кругов
 * ревью угадывания «его ли это имя» каждый раз находили новый случай, где
 * стиралось чужое или оставалось его. Доказано, когда:
 *   - карточку завела не рука партнёра (origin <> 'manual'): ручную карточку
 *     партнёр заводит о человеке, которого знает, и это может быть другой
 *     клиент с тем же номером;
 *   - ссылка на аккаунт пуста или его;
 *   - каждая её связь — его источник (HIS_SOURCE);
 *   - записей партнёра о клиенте в ней нет: ни заметки, ни меток, ни задач,
 *     ни касаний (HAND_TITLE_KINDS). Номер у партнёра — одна карточка:
 *     ручное добавление с тем же номером отвечает «клиент уже есть»
 *     (createManualContact) и ведёт в неё же, и всё, что партнёр узнал о
 *     другом человеке с этим номером, — «Мария, мама Андрея: диабет» —
 *     ложится в его карточку. О ком запись, по строке не различить;
 *   - партнёр её не переименовывал (renamed_by_partner_at, миграция 1313,
 *     пишет updateContact): имя, которое партнёр дал карточке, — тоже его
 *     запись, и бывает о другом человеке с тем же номером («Мария Ивановна,
 *     мама Андрея»). Переименования до 1313 следа не оставили (updateContact
 *     писал только updated_at, который двигает и склейка) — их не различить,
 *     и имя такой карточки уходит вместе с ней.
 * Строка «Telegram: …», которую миграция 1200 перенесла в заметку его
 * карточки, к этому моменту уже снята (STRIP_TELEGRAM_COPY): это копия его
 * карточки у оператора, а не запись партнёра о ком-то другом.
 * Такая карточка стирается шагами eraseUser: имя, контакты, согласие и
 * тексты событий его броней. Любая другая карточка, где он есть, — не
 * доказанно его (detachFromUnprovenCrmContacts).
 */
const PROVEN_HIS_CARD = (c: string) => `(${c}.origin <> 'manual'
          AND (${c}.user_id IS NULL OR ${c}.user_id = $1)
          AND NOT EXISTS (SELECT 1 FROM crm_contact_links ol
                           WHERE ol.contact_id = ${c}.id AND NOT ${HIS_SOURCE('ol')})
          AND NULLIF(btrim(${c}.notes), '') IS NULL
          AND cardinality(${c}.tags) = 0
          AND ${c}.renamed_by_partner_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM crm_tasks pt WHERE pt.contact_id = ${c}.id)
          AND NOT EXISTS (SELECT 1 FROM crm_events pe WHERE pe.contact_id = ${c}.id AND pe.kind IN (${HAND_KINDS_SQL})))`;

/**
 * Его карточки клиента у партнёров, которые стираются (PROVEN_HIS_CARD).
 * Доказанность проверяется заново в каждом шаге, а не берётся из того, что
 * нашёл detachFromUnprovenCrmContacts: карточки, где он был к тому моменту,
 * заперты до конца транзакции и не меняются, но карточка, куда его бронь
 * легла параллельно уже после этого (крон склейки), иначе стёрлась бы
 * целиком, не будучи доказанно его. Шаг crm_contacts снимает ссылку на
 * аккаунт, поэтому события стираются ДО него.
 */
const HIS_CRM_CONTACTS = `SELECT pc.id FROM crm_contacts pc
      WHERE pc.id IN (${CRM_CONTACTS_WITH_HIM}) AND ${PROVEN_HIS_CARD('pc')}`;

/**
 * Его события в ленте карточки, доказанные столбцами: по его источникам и
 * сообщения его бесед — в обе стороны (recordChatMessageQuietly пишет их по
 * аккаунту, без источника, беседа — в payload).
 */
const HIS_EVENT = (e: string) => `(${HIS_SOURCE(e)}
        OR (${e}.source_kind IS NULL AND ${e}.payload->>'conversation_id' IN (
              SELECT cp.conversation_id::text FROM conversation_participants cp WHERE cp.user_id = $1)))`;

/** Ключи счёта в ответе eraseUser: сколько карточек CRM не доказанно его и у скольких партнёров они лежат. */
export const UNPROVEN_CRM_CARDS = 'crm_contacts_unproven';
export const UNPROVEN_CRM_PARTNERS = 'crm_contacts_unproven_partners';

/** Карточки CRM, где он был, но которые не доказанно его: сколько и у скольких партнёров. */
export interface UnprovenCrm {
  cards: number;
  partners: number;
}

/**
 * Что увёл один проход detachFromUnprovenCrmContacts — с id карточек и
 * партнёров: eraseUser проходит дважды (до шагов и перед лентой) и
 * складывает проходы без двойного счёта одной карточки и одного партнёра.
 */
export interface DetachedCrm extends UnprovenCrm {
  cardIds: string[];
  partnerIds: string[];
}

/**
 * Копия карточки оператора о нём в его карточке CRM (миграция 1200,
 * operator_client_notes → crm_contacts). Старый экран «Клиенты» оператора
 * хранил метки и ник в Telegram клиента по паре (оператор, ЕГО аккаунт), и
 * 1200 дописала ник строкой «Telegram: …» в заметку карточки с той же парой
 * (partner_id = operator_id, user_id = его аккаунт). Сам eraseUser считает
 * эту таблицу его данными и удаляет её строку (шаг operator_client_notes), а
 * копия оставалась — и, будучи непустой заметкой, делала его карточку «не
 * доказанно его» (PROVEN_HIS_CARD): из карточки, где все связи — его брони, не
 * стирались имя, телефон и почта, а ответ говорил «по общему номеру мы не
 * можем отличить вас от другого клиента» при единственной записи — о нём же.
 *
 * Снимается ровно то, что записала 1200, по столбцу, а не по похожести:
 * строка заметки, совпадающая слово в слово с той, что 1200 строит из
 * operator_client_notes.telegram его пары (то же выражение), пока строка
 * operator_client_notes ещё есть — поэтому ДО шагов и до решения о карточках.
 * Ник в Telegram — его идентификатор, записанный партнёром как ЕГО (ключ —
 * его аккаунт), чья бы ни была остальная карточка. Остальной текст заметки —
 * как был; пустая после этого заметка — NULL.
 *
 * Метки 1200 не снимаются. Она не дописывала метку, которая уже стояла у
 * карточки, и метку, поставленную партнёром на экране CRM, от перенесённой
 * по строке не отличить: снять её — стереть, возможно, запись партнёра о
 * другом клиенте с тем же номером. Такие метки держат карточку «не доказанно
 * его», и ответ называет это (unprovenCrmSentence).
 */
const TELEGRAM_LINE_1200 = `('Telegram: ' || CASE WHEN n.telegram ~ '^\\d+$' THEN n.telegram ELSE '@' || n.telegram END)`;
const NOTES_WITHOUT_1200_LINE = `array_to_string(array_remove(string_to_array(crm_contacts.notes, E'\\n'), ${TELEGRAM_LINE_1200}), E'\\n')`;
const STRIP_TELEGRAM_COPY = `UPDATE crm_contacts SET
        notes = CASE WHEN btrim(${NOTES_WITHOUT_1200_LINE}, E' \\t\\r\\n') = '' THEN NULL ELSE ${NOTES_WITHOUT_1200_LINE} END,
        updated_at = NOW()
      FROM operator_client_notes n
      WHERE n.user_id = $1 AND crm_contacts.user_id = $1 AND crm_contacts.partner_id = n.operator_id
        AND NULLIF(btrim(n.telegram), '') IS NOT NULL
        AND ${TELEGRAM_LINE_1200} = ANY(string_to_array(crm_contacts.notes, E'\\n'))`;

/**
 * Карточки CRM, где он есть, но которые не доказанно его (PROVEN_HIS_CARD):
 * ручная карточка партнёра, ссылка на другой аккаунт, связь, которая не его
 * источник — заявка, клиент агента, бронь другого аккаунта, — или записи
 * партнёра о клиенте. Чьи в такой карточке имя, телефон и почта и о ком
 * записи партнёра, платформа не знает: «Андрей Петров» в заявке тем же
 * номером — он, его брат или сосед. Чужое по догадке не стирается, поэтому
 * из карточки уходит только доказанно его:
 *   - его связи (crm_contact_links по его источникам) удаляются. Бронь без
 *     связи клиентом снова не станет: склейка и задел не берут строки стёртого
 *     аккаунта (lib/crm/source-specs, notErasedAccount);
 *   - его события (HIS_EVENT) уходят из ленты карточки (contact_id = NULL —
 *     «клиент удалён после записи события», миграция 1196); обезличивает их
 *     шаг crm_events — он берёт события по его источникам, где бы они ни
 *     лежали (у сообщений беседы в ленте нет текста, только её id);
 *   - ссылка на его аккаунт снимается, если стояла.
 * Имя, телефон, почта, согласие, заметки, метки, задачи и касания карточки
 * не трогаются (UNPROVEN_CARD_KEEP), и ответ человеку говорит это прямо и
 * называет, куда написать (unprovenCrmSentence); стирает такую карточку по
 * обращению администратор (eraseCrmContactOnRequest).
 *
 * Сначала запираются ВСЕ карточки, где он есть, и только потом отдельным
 * запросом решается, какие доказанно его. Запрет на запись в запертую
 * карточку держит и её дочерние строки: связь, событие и задача ссылаются на
 * неё внешним ключом, и вставка ждёт конца транзакции. Иначе параллельная
 * склейка (хук брони, крон crm-contacts-sync) успевала положить в его
 * доказанную карточку чужую бронь с почтой, и шаг crm_contacts стирал её
 * вместе с его. После конца транзакции склейка ищет карточку заново — по
 * стёртому телефону уже не найдёт и заведёт другому клиенту свою. Решение —
 * вторым запросом: его снимок берётся после того, как запоры получены, и
 * видит всё, что успело записаться до них.
 *
 * Зовётся ДО шагов: шаги crm_events и crm_contacts стирают карточку, где он
 * ещё есть и которая доказанно его (HIS_CRM_CONTACTS), а его брони из
 * Telegram (HIS_BOOKINGS) находятся по users.telegram_id, который стирает шаг
 * users. И второй раз — перед шагом crm_events, после шагов его источников:
 * склейка, начатая во время стирания, кладёт его источник в карточку, где его
 * к первому проходу не было (запирают её только карточки, где он уже есть), и
 * второй проход уводит его связь и оттуда (eraseUser). Возвращает счёт для
 * ответа с id карточек и партнёров — проходы складываются без повторов: после
 * стирания такие карточки по нему уже не найти.
 */
export async function detachFromUnprovenCrmContacts(db: EraseQueryable, userId: string): Promise<DetachedCrm> {
  const none: DetachedCrm = { cards: 0, partners: 0, cardIds: [], partnerIds: [] };
  const locked = await db.query(
    `SELECT id::text AS id FROM crm_contacts WHERE id IN (${CRM_CONTACTS_WITH_HIM}) ORDER BY id FOR UPDATE`,
    [userId],
  );
  if (locked.rows.length === 0) return none;
  const { rows } = await db.query(
    `SELECT uc.id::text AS id, uc.partner_id::text AS partner_id FROM crm_contacts uc
      WHERE uc.id = ANY($2::uuid[]) AND NOT ${PROVEN_HIS_CARD('uc')}`,
    [userId, locked.rows.map((r) => String(r.id))],
  );
  if (rows.length === 0) return none;
  const ids = rows.map((r) => String(r.id));
  await db.query(
    `UPDATE crm_events SET contact_id = NULL WHERE contact_id = ANY($2::uuid[]) AND ${HIS_EVENT('crm_events')}`,
    [userId, ids],
  );
  await db.query(
    `DELETE FROM crm_contact_links WHERE contact_id = ANY($2::uuid[]) AND ${HIS_SOURCE('crm_contact_links')}`,
    [userId, ids],
  );
  await db.query(
    `UPDATE crm_contacts SET user_id = NULL, updated_at = NOW() WHERE id = ANY($2::uuid[]) AND user_id = $1`,
    [userId, ids],
  );
  const partnerIds = [...new Set(rows.map((r) => String(r.partner_id)))];
  return { cards: ids.length, partners: partnerIds.length, cardIds: ids, partnerIds };
}

/**
 * Подпись вместо причины отмены или отказа. Причину пишет человек — оператор,
 * хозяин жилья, перевозчик или сам турист («турист в больнице с переломом») —
 * и она о нём. Строка остаётся отменённой, и что причина была, видно; пустая
 * причина пустой и остаётся: выдумывать, что она была, нельзя.
 */
export const ERASED_REASON = 'Причина удалена вместе с аккаунтом';
const reasonErased = (col: string) =>
  `${col} = CASE WHEN NULLIF(btrim(${col}), '') IS NULL THEN ${col} ELSE ${sqlTextLiteral(ERASED_REASON)} END`;

/**
 * Подпись вместо комментария к смене статуса его брони (booking_logs), кроме
 * отмены. Комментарий к подтверждению, переносу и завершению пишет оператор
 * (confirmBooking принимает любой текст, перенос — текст оператора до 500
 * знаков) или код («Тур завершён»); различить их по строке нельзя, а слова
 * оператора бывают о человеке («перенос: у туриста температура») — как и
 * заметка оператора о брони (operator_bookings.notes), они стираются.
 * Переход, время и кто его сделал — остаются.
 */
export const ERASED_COMMENT = 'Комментарий удалён вместе с аккаунтом';

/**
 * Подпись вместо адресата-контакта в журнале доставки тревог по его контролям
 * (route_registration_notifications.recipient: сторож пишет туда телефон или
 * почту экстренного контакта). Не роль (JOURNAL_ROLE_RECIPIENTS): строка
 * остаётся следом того, что ступень уходила контакту, — разбор случая видит
 * ступень, канал и исход, но не адрес. Читатели журнала берут его только у
 * открытого контроля или у закрытого в пределах TRIP_WATCH_CLOSURE_HOLD_HOURS
 * (announceToAlerted), а такой удаление держит (CLOSED_WATCH_MAY_ALERT).
 */
export const ERASED_RECIPIENT = 'Контакт удалён вместе с аккаунтом';

/**
 * Подпись вместо текста отказа доставки, где назван адрес из регистрации:
 * почтовый сервер, отвергая письмо, повторяет адрес получателя («550 <…>:
 * Recipient address rejected»), а сторож пишет этот ответ в журнал и
 * дежурному. Отказ без адреса остаётся как был — он нужен разбору.
 */
export const ERASED_DELIVERY_ERROR = 'Текст отказа удалён вместе с аккаунтом: в нём был адрес из регистрации';

/** Адреса регистрации, которые удаление стирает и которые могли попасть в текст отказа доставки. */
const WATCH_ADDRESS_COLUMNS = [
  'emergency_contact_email', 'emergency_contact_phone', 'emergency_contact_telegram_chat_id::text',
  'leader_email', 'leader_phone', 'tourist_chat_id::text',
] as const;
const MENTIONS_WATCH_ADDRESS = (text: string, r: string) => `(${text} IS NOT NULL AND (${WATCH_ADDRESS_COLUMNS
  .map((c) => `(NULLIF(btrim(${r}.${c}), '') IS NOT NULL AND strpos(lower(${text}), lower(btrim(${r}.${c}))) > 0)`)
  .join(' OR ')}))`;

/**
 * Его id в мессенджерах, которыми канал карточки партнёра доказанно его.
 * Telegram: users.telegram_id и telegram_chat_id — в личке id чата равен id
 * человека; так канал пишут вход через Telegram (app/api/auth/telegram —
 * telegram_chat_id = id человека) и «Старт» по ссылке привязки в личке
 * (lib/partners/bind-channel — id чата, и его зеркало в contacts). Группа
 * команды — свой id, не его. MAX: users.max_user_id, а привязка пишет id
 * ДИАЛОГА (update.chat_id), которого в users нет, — диалог с ботом доказан
 * перепиской: строка tg_conversations с этим chat_id и его max_user_id
 * (lib/kuzmich/core пишет так каждую реплику). Подзапрос стоит во FROM шага, а
 * не в SET: ключи живут в users и tg_conversations, поэтому шаг — до них.
 */
const HIS_MESSENGER_IDS = `SELECT
        ARRAY(SELECT v.id FROM users u
                CROSS JOIN LATERAL (VALUES (u.telegram_id::bigint), (u.telegram_chat_id::bigint)) AS v(id)
               WHERE u.id = $1 AND v.id IS NOT NULL) AS tg,
        ARRAY(SELECT u.max_user_id::bigint FROM users u WHERE u.id = $1 AND u.max_user_id IS NOT NULL
              UNION
              SELECT t.chat_id::bigint FROM tg_conversations t JOIN users u ON u.id = $1
               WHERE t.platform = 'max' AND t.user_id = u.max_user_id) AS mx,
        ARRAY(SELECT u.telegram_id::bigint FROM users u WHERE u.id = $1 AND u.telegram_id IS NOT NULL) AS tu,
        ARRAY(SELECT u.max_user_id::bigint FROM users u WHERE u.id = $1 AND u.max_user_id IS NOT NULL) AS mu`;
const OWN_TG = (p: string) => `${p}.telegram_chat_id::bigint = ANY(his.tg)`;
const OWN_MAX = (p: string) => `${p}.max_chat_id::bigint = ANY(his.mx)`;
/** Владелец ссылки подключения (1336) — его id человека (tu, mu), не id чата. */
const OWN_LINK_TG = (p: string) => `${p}.telegram_owner_user_id = ANY(his.tu)`;
const OWN_LINK_MAX = (p: string) => `${p}.max_owner_user_id = ANY(his.mu)`;
const OWN_TG_MIRROR = (p: string) => `(jsonb_typeof(${p}.contacts) = 'object'
          AND (${p}.contacts->>'telegram_chat_id') = ANY(his.tg::text[]))`;

/**
 * Таблицы, где шаг eraseUser не стирает строку как его, а снимает с чужой
 * строки только его идентификаторы. Строки, которые ссылаются на такую
 * таблицу, — не его, и перепись сторожа полноты не считает их его данными по
 * этой связи (tests/helpers/pd-census.ts, personDataCensus). Запись
 * самоустаревает: шага по таблице нет — сторож красный.
 */
export const ERASE_DETACH_ONLY: Readonly<Record<string, string>> = {
  partners: 'карточка партнёра — данные бизнеса по договору (компания, ИП, гид); шаг partners снимает с неё только '
    + 'его каналы в мессенджерах, а туры, машины, заявки и брони, ссылающиеся на карточку, — партнёра и его клиентов',
};

/**
 * Таблицы, ссылающиеся на карточку из ERASE_DETACH_ONLY и хранящие id в
 * мессенджере, но не копию его канала — с причиной. Перепись полноты такие
 * таблицы не берёт (ссылка на карточку — не ссылка на него), а id чата в них
 * может оказаться его диалогом: так было с предложениями «открыть даты»
 * (ревью этапа C 22.10), и шаг для них стоит в eraseUser. Сторож
 * (tests/unit/account-erase-coverage.test.ts) требует у каждой такой таблицы
 * шаг, место в переписи, в ERASE_UNLINKED или запись здесь; запись
 * самоустаревает — у таблицы появился шаг, или её нет в схеме.
 */
export const PARTNER_MESSENGER_NOT_HIS: Readonly<Record<string, string>> = {
  operator_ai_config: 'max_owner_chat_id есть только в baseline: ни один файл lib/, app/ и migrations/ её не пишет и не читает '
    + '(перепись 22.10) — копии канала нет, пока у колонки нет производителя',
};


/**
 * Заголовок касания или «задача выполнена» после стирания карточки по
 * обращению (eraseCrmContactOnRequest): его пишет человек — партнёр, Кузьмич
 * или MCP партнёра по его просьбе («Звонил Иван, у мамы диабет»), — и он
 * становится подписью рода. Заголовки, которые строит код, не трогаются.
 */
const HAND_TITLE_TO_LABEL = `CASE kind ${HAND_TITLE_KINDS
  .map((k) => `WHEN ${sqlTextLiteral(k)} THEN ${sqlTextLiteral(EVENT_KIND_LABELS[k])}`).join(' ')} ELSE title END`;

/** Заголовок задачи по клиенту после стирания: текст задачи пишет партнёр. */
export const ERASED_TASK_TITLE = 'Задача';

/** Что стёрто в карточке по обращению — счёт без ПД, для ответа администратору и журнала. */
export interface CrmRequestErasure {
  partnerId: string;
  events: number;
  tasks: number;
}

/**
 * Стереть карточку клиента CRM по обращению человека (152-ФЗ, ст. 21) —
 * исполнитель того, что обещает unprovenCrmSentence. Удаление аккаунта
 * карточку, которая не доказанно его, не стирает: по общему номеру платформа
 * не отличит его от другого клиента. Отличить может человек — по письму, где
 * назван номер и почта, администратор находит карточки (поиск на экране
 * клиентов всех партнёров), сверяет и стирает:
 *   - имя, телефон, почту, адрес согласия, заметку и метки карточки, ссылку
 *     на аккаунт (карточка больше ни за кем не числится; новая заявка с тем
 *     же номером заведёт новую);
 *   - тексты задач по клиенту и касаний ленты (заголовок, который пишет
 *     человек, становится подписью рода) и свободный текст из payload всех
 *     событий карточки — как шаг crm_events удаления аккаунта.
 * Отметка, что согласие было записано, и связи с источниками остаются: это
 * след обработки и id строк. Сами источники — заявки и брони, связанные с
 * карточкой, — это не стирает: среди них могут быть заявки другого клиента с
 * тем же номером, и выбрать «его» заявки по имени значило бы угадывать. Имя и
 * телефон, записанные в заявке, остаются у партнёра, и экран администратора и
 * ответ человеку говорят это (EraseOnRequest, unprovenCrmSentence); карточка
 * со стёртым клиентом не подписывает источник его именем («Записан как»,
 * ContactPanel), чтобы не вернуть имя в карточку, из которой его стёрли.
 * Вызывать в транзакции; карточки нет — null. Кто и почему стёр, записывает
 * вызывающий (POST /api/admin/crm/contacts/[id]/erase).
 */
export async function eraseCrmContactOnRequest(db: EraseQueryable, contactId: string): Promise<CrmRequestErasure | null> {
  const { rows } = await db.query(
    `SELECT partner_id::text AS partner_id FROM crm_contacts WHERE id = $1 FOR UPDATE`,
    [contactId],
  );
  if (!rows[0]) return null;
  const events = await db.query(
    `UPDATE crm_events SET payload = payload - 'details' - 'reason' - 'comment', title = ${HAND_TITLE_TO_LABEL}
      WHERE contact_id = $1`,
    [contactId],
  ) as { rowCount?: number };
  const tasks = await db.query(
    `UPDATE crm_tasks SET title = ${sqlTextLiteral(ERASED_TASK_TITLE)}, details = NULL WHERE contact_id = $1`,
    [contactId],
  ) as { rowCount?: number };
  await db.query(
    `UPDATE crm_contacts SET user_id = NULL, display_name = ${sqlTextLiteral(ERASED_NAME)},
        phone = NULL, phone_e164 = NULL, email = NULL, email_norm = NULL,
        notes = NULL, tags = '{}', pd_consent_ip = NULL, updated_at = NOW()
      WHERE id = $1`,
    [contactId],
  );
  return { partnerId: String(rows[0].partner_id), events: events.rowCount ?? 0, tasks: tasks.rowCount ?? 0 };
}

/**
 * Его разговоры с Кузьмичом в chat_sessions: веб-чат пишет user_id
 * (app/api/ai/chat, chat-stream), прежний вебхук Telegram — строку
 * 'tg_<chat_id>' без user_id (до TG-BRAIN; миграция 1287 их скопировала в
 * tg_conversations, но не удалила). В личке chat_id равен id человека,
 * поэтому сверка — по обоим ключам Telegram из users. MAX в chat_sessions
 * не писал никогда (история git: писатели — веб-чат, стрим, виджет и вебхук
 * Telegram). Ключи живут только в users, поэтому шаги — ДО шага users.
 */
const HIS_CHAT_SESSIONS = `SELECT id FROM chat_sessions
      WHERE user_id = $1
         OR session_id IN (
           SELECT 'tg_' || telegram_id FROM users WHERE id = $1 AND telegram_id IS NOT NULL
           UNION SELECT 'tg_' || telegram_chat_id FROM users WHERE id = $1 AND telegram_chat_id IS NOT NULL
         )`;

/**
 * Обезличить пользователя и всё, что за ним записано. Вызывать в транзакции.
 * Возвращает число затронутых строк по таблицам — для аудита, без ПД.
 */
export async function eraseUser(
  db: EraseQueryable,
  userId: string,
  reason: 'account_deleted' | 'consent_revoked',
): Promise<Record<string, number>> {
  const N = ERASED_NAME;
  // Первым — копия его карточки у оператора в заметке его карточки CRM
  // (миграция 1200): пока строка operator_client_notes ещё есть, и до решения
  // о карточках, которое она иначе испортила бы (STRIP_TELEGRAM_COPY).
  const telegramCopy = await db.query(STRIP_TELEGRAM_COPY, [userId]) as { rowCount?: number };
  // До шагов: из карточек CRM, которые не доказанно его, уходят его связи,
  // события и ссылка на аккаунт — пока его брони из Telegram ещё находятся
  // по users.telegram_id (detachFromUnprovenCrmContacts).
  const early = await detachFromUnprovenCrmContacts(db, userId);
  const steps: Array<[string, string]> = [
    // Первый шаг: остальные шаги и счёт оставшегося находят его брони по
    // user_id. Бронь из Telegram до привязки (HIS_BOOKINGS) здесь получает
    // user_id = $1 — после снятия метки и шага users её иначе не найти.
    // notes — заметка оператора о брони (кабинет оператора), special_requests —
    // пожелания самого туриста: свободный текст о человеке.
    // metadata несёт метку канала брони из чата — tg_chat_id (id человека в
    // мессенджере, lib/kuzmich/core) — и ссылку user_id на тот же аккаунт;
    // метка снимается, ссылка и прочее (platform, agent_client_id) — не ПД.
    // cancellation_reason — причина отмены словами оператора или самого
    // туриста (кабинет оператора, cancelBooking) — становится подписью.
    ['operator_bookings', `UPDATE operator_bookings SET user_id = $1,
        tourist_name = '${N}', tourist_email = NULL, tourist_phone = NULL,
        notes = NULL, special_requests = NULL, pd_consent_ip = NULL, metadata = metadata - 'tg_chat_id',
        ${reasonErased('cancellation_reason')}
      WHERE id IN (${HIS_BOOKINGS})`],
    // Журнал смены статуса его броней. Комментарий к отмене — причина отмены
    // словами самого туриста (cancelBooking: POST /api/bookings/[id]/cancel и
    // PATCH /api/bookings/[id], до 1000 знаков, бывает о здоровье) или
    // оператора, с хвостом о возврате — становится той же подписью, что
    // cancellation_reason; прочие комментарии — ERASED_COMMENT. Пустой пустым
    // и остаётся.
    ['booking_logs', `UPDATE booking_logs SET comment = CASE
          WHEN NULLIF(btrim(comment), '') IS NULL THEN comment
          WHEN to_status = 'cancelled' THEN ${sqlTextLiteral(ERASED_REASON)}
          ELSE ${sqlTextLiteral(ERASED_COMMENT)} END
      WHERE booking_id IN (${HIS_BOOKINGS})`],
    // Третья копия причины отклонения его брони — в журнале действия кнопкой
    // из чата гида (миграция 1341, lib/bookings/chat-owner-action): «Отклонить»
    // кладёт слова продавца в partner_chat_actions.reason дословно, и там же
    // они остаются, если после причины нажато «Не надо». Строка ссылается на
    // бронь текстом (subject_id) без внешнего ключа, и перепись её по брони
    // не видит; шаг partner_chat_actions ниже снимает только строки чатов
    // самого удаляемого. Причина — та же подпись, что в брони; журнал
    // действия гида (кто, что, когда, итог) остаётся.
    ['partner_chat_actions.reason', `UPDATE partner_chat_actions SET ${reasonErased('reason')}
      WHERE subject_kind = 'booking'
        AND subject_id IN (SELECT hb.id::text FROM (${HIS_BOOKINGS}) hb)
        AND NULLIF(btrim(reason), '') IS NOT NULL`],
    // full_name NOT NULL (baseline) — имя-заглушка; отметки согласия и МЧС —
    // не ПД, а след обработки, они остаются.
    ['booking_group_members', `UPDATE booking_group_members SET full_name = '${N}', phone = NULL,
        passport_number = NULL, passport_encrypted = NULL,
        emergency_contact_name = NULL, emergency_contact_phone = NULL,
        dietary_restrictions = NULL, medical_notes = NULL, medical_encrypted = NULL
      WHERE booking_id IN (${HIS_BOOKINGS})`],
    // Переход по ссылке агента, закончившийся его бронью. Сейчас ip и
    // user_agent здесь не пишет никто (lib/bookings/reserve.ts, app/r/[code]),
    // но колонки есть, и старые строки могли их нести.
    ['agent_referral_events', `UPDATE agent_referral_events SET ip = NULL, user_agent = NULL
      WHERE booking_id IN (${HIS_BOOKINGS})`],
    ['gear_rentals', `UPDATE gear_rentals SET customer_name = '${N}', customer_email = '', customer_phone = '',
        comments = NULL, pd_consent_ip = NULL
      WHERE user_id = $1`],
    // Живых заказов здесь нет: будущую поездку держит findEraseBlockers.
    // decline_reason — причина отказа словами перевозчика (lib/transfers/service).
    // До ленты CRM, как и прочие его источники (см. второй проход
    // detachFromUnprovenCrmContacts в цикле ниже).
    ['transfer_seat_bookings', `UPDATE transfer_seat_bookings SET contact_phone = NULL, comment = NULL,
        ${reasonErased('decline_reason')}
      WHERE ordered_by_user_id = $1`],
    // Старый модуль трансферов: писателей в коде нет, строки — прошлые.
    // Адреса и точки подачи и высадки (гостиница, дом) и отзыв о поездке —
    // о человеке; pickup/dropoff_location NOT NULL, поэтому пустая строка.
    // cancellation_reason — как у брони тура: подпись вместо слов о человеке.
    ['transfers', `UPDATE transfers SET client_name = '${N}', client_phone = '', client_email = NULL,
        notes = NULL, special_requests = NULL, feedback = NULL, ${reasonErased('cancellation_reason')},
        pickup_location = '', dropoff_location = '', pickup_coordinates = NULL, dropoff_coordinates = NULL
      WHERE user_id = $1`],
    // cancellation_reason — причина отмены словами хозяина жилья гостю
    // (lib/stay/booking-status-sql). refund_reason пишет код — см. ERASE_KEEP.
    ['accommodation_bookings', `UPDATE accommodation_bookings SET guest_notes = NULL, special_requests = NULL,
        ${reasonErased('cancellation_reason')}
      WHERE user_id = $1`],
    // Переписка обращения (messages) и его тема — его слова; решение
    // поддержки — о нём. Строка остаётся для счёта обращений, без текста.
    ['support_tickets', `UPDATE support_tickets SET user_name = '${N}', user_email = NULL,
        messages = '[]'::jsonb, subject = '', resolution = NULL
      WHERE user_id = $1`],
    // notes здесь пишет система (исход сигнала), не человек — см. ERASE_KEEP;
    // место и время сигнала — там же. Текст сигнала («сломал ногу у озера»)
    // — его слова, бывает и о здоровье.
    ['sos_events', `UPDATE sos_events SET tourist_name = '${N}', tourist_phone = NULL, ip_address = NULL, user_agent = NULL,
        message = NULL
      WHERE user_id = $1`],
    ['booking_waivers', `UPDATE booking_waivers SET signer_name = '${N}', emergency_contact_name = '', emergency_contact_phone = '',
        medical_conditions = NULL, allergies = NULL
      WHERE user_id = $1`],
    // Журнал доставки тревог по его контролям — ДО шага route_registrations:
    // адреса, по которым узнаётся текст отказа, берутся из регистрации, а шаг
    // ниже их стирает. Адресат-контакт (телефон или почта) становится
    // подписью, роли (дежурный, сам турист) остаются; текст отказа, где назван
    // адрес, — подписью. Ступень, канал, исход и время — след для разбора.
    // Журнал читают для отбоя (announceToAlerted) — у закрытого недавно
    // контроля, по которому сторож мог писать, удаление держит
    // (CLOSED_WATCH_MAY_ALERT), поэтому здесь отбою уже не нужен адрес.
    ['route_registration_notifications', `UPDATE route_registration_notifications SET
        recipient = CASE WHEN route_registration_notifications.recipient IN (${JOURNAL_ROLES_SQL})
          THEN route_registration_notifications.recipient ELSE ${sqlTextLiteral(ERASED_RECIPIENT)} END,
        error_message = CASE WHEN ${MENTIONS_WATCH_ADDRESS('route_registration_notifications.error_message', 'r')}
          THEN ${sqlTextLiteral(ERASED_DELIVERY_ERROR)} ELSE route_registration_notifications.error_message END
      FROM route_registrations r
      WHERE route_registration_notifications.registration_id = r.id AND r.user_id = $1`],
    // Открытых контролей здесь нет: регистрацию без отметки о возвращении
    // держит findEraseBlockers (OPEN_TRIP_WATCH — тот же предикат, что у
    // сторожа невозвращения), и стираются только закрытые, по которым никого
    // уже не ищут; закрытый недавно, по которому сторож мог писать контакту,
    // держит тоже (CLOSED_WATCH_MAY_ALERT) — пока не дошёл отбой. group_members — спутники (имя, телефон, год рождения), route_description
    // — его слова о маршруте, last_position_* — где он был: точка с телефона
    // или трекера и её источник. Все NULL-допустимы (baseline, 680, 995).
    ['route_registrations', `UPDATE route_registrations SET leader_name = '${N}', leader_phone = '', leader_email = NULL,
        emergency_contact_name = '', emergency_contact_phone = '', emergency_contact_email = NULL,
        emergency_contact_relation = NULL, emergency_contact_telegram_chat_id = NULL, tourist_chat_channel = NULL, tourist_chat_id = NULL,
        group_members = NULL, route_description = NULL,
        last_position_lat = NULL, last_position_lng = NULL, last_position_at = NULL, last_position_source = NULL
      WHERE user_id = $1`],
    // Лента его карточек у партнёров (HIS_CRM_CONTACTS — до шага
    // crm_contacts, который снимает ссылку на аккаунт) и события по его
    // источникам, где бы они ни лежали: без карточки (detachFromUnprovenCrmContacts
    // увёл их из карточки, которая не доказанно его) или в его карточке.
    // Касаний и задач в его карточке нет (PROVEN_HIS_CARD), а у событий его
    // источников заголовок строит код из статусов и сумм — заголовки
    // остаются. Из payload снимается свободный текст: details, reason
    // (причина отмены или отказа — словами оператора, перевозчика или самого
    // туриста: кабинет оператора, cancelBooking, отказ в заказе мест) и
    // comment (комментарий к подтверждению брони: confirmBooking принимает
    // любой текст). Остальное в payload пишет код: статусы, даты, суммы,
    // канал, id беседы, процент возврата. Касания и задачи карточки, которая
    // не доказанно его, остаются (UNPROVEN_CARD_KEEP).
    ['crm_events', `UPDATE crm_events SET payload = payload - 'details' - 'reason' - 'comment'
      WHERE contact_id IN (${HIS_CRM_CONTACTS}) OR ${HIS_SOURCE('crm_events')}`],
    // Его карточка клиента. Заметка и метки в ней пусты по определению
    // (PROVEN_HIS_CARD; пробельная заметка — та же пустота) — шаг стирает их
    // всё равно, чтобы и сам по себе не оставлял записей о человеке. Ссылка
    // на аккаунт снимается: у человека, бронировавшего у одного партнёра с
    // двух телефонов, две карточки с его user_id, а без телефона и почты их
    // держал бы уникальный индекс crm_contacts_partner_user_uq — удаление
    // падало бы на 23505.
    ['crm_contacts', `UPDATE crm_contacts SET user_id = NULL, display_name = '${N}',
        phone = NULL, phone_e164 = NULL, email = NULL, email_norm = NULL,
        notes = NULL, tags = '{}', pd_consent_ip = NULL
      WHERE id IN (${HIS_CRM_CONTACTS})`],
    // Карточка клиента у оператора: метки и ник в Telegram — о человеке, и
    // ничего, кроме этого, в строке нет.
    ['operator_client_notes', `DELETE FROM operator_client_notes WHERE user_id = $1`],
    // Менеджер в команде оператора: удалённый аккаунт снимается с команды
    // тем же образом, что revokeMember (lib/operators/team.ts), и его чаты для
    // уведомлений стираются — иначе рассылка с ПД туристов шла бы в мессенджер
    // человека, удалившего аккаунт. revoked_by — NULL: снял не человек.
    ['operator_members', `UPDATE operator_members SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW()),
        invite_token_hash = NULL, max_chat_id = NULL, telegram_chat_id = NULL, channel_bound_at = NULL, updated_at = NOW()
      WHERE user_id = $1`],
    ['operator_signups', `UPDATE operator_signups SET telegram_handle = NULL WHERE user_id = $1`],
    ['audit_logs', `UPDATE audit_logs SET ip_address = NULL, user_agent = NULL WHERE user_id = $1`],
    ['user_ai_memory', `DELETE FROM user_ai_memory WHERE user_id = $1`],
    // Оценка ответа Кузьмича: автор — в metadata.author_user_id, свой
    // комментарий — там же (app/api/tourist/feedback/agent). Оценка остаётся
    // счётом качества, без текста и без ссылки на него. Колонка user_id
    // таблицы — integer, не id аккаунта, и её не пишет никто.
    ['ai_actions_log', `UPDATE ai_actions_log SET metadata = metadata - 'comment' - 'author_user_id'
      WHERE action_type = 'agent_feedback' AND metadata->>'author_user_id' = $1::text`],
    // Отзывы о качестве ответов базы знаний: писателя в коде нет, user_id —
    // текст; что осталось от прошлого, удаляется вместе с его вопросами.
    ['rag_feedback', `DELETE FROM rag_feedback WHERE user_id = $1::text`],
    // Его уведомления и их настройки — адресованы ему одному. Журнал доставки
    // этих уведомлений — явно, до них: каскад ключа сделал бы это сам, но
    // стирание не должно от него зависеть.
    ['notification_log', `DELETE FROM notification_log
      WHERE notification_id IN (SELECT id FROM notifications WHERE user_id = $1)`],
    ['notifications', `DELETE FROM notifications WHERE user_id = $1`],
    ['notification_preferences', `DELETE FROM notification_preferences WHERE user_id = $1`],
    // Его планы поездки: состав компании (party), рейсы, дни. users.active_trip_id
    // обнуляет внешний ключ (ON DELETE SET NULL).
    ['user_trips', `DELETE FROM user_trips WHERE user_id = $1`],
    // Его сообщения в переписке с оператором: текст и вложения стираются,
    // строка остаётся помеченной удалённой — как у удалённого сообщения,
    // чтобы разговор оператора не терял порядок. Ответы оператора — его.
    ['conversation_messages', `UPDATE conversation_messages SET content = '', attachments = '[]'::jsonb, is_deleted = true
      WHERE sender_id = $1`],
    // Точка, откуда он отправил наблюдение о месте, — где он был. Само
    // наблюдение («мост смыт») — предупреждение другим, см. ERASE_KEEP.
    ['place_safety_reports', `UPDATE place_safety_reports SET reporter_lat = NULL, reporter_lng = NULL WHERE user_id = $1`],
    ['reviews', `UPDATE reviews SET author_name = '${N}' WHERE user_id = $1`],
    ['operator_tour_reviews', `UPDATE operator_tour_reviews SET author_name = '${N}', author_city = NULL WHERE user_id = $1`],
    ['carrier_reviews', `UPDATE carrier_reviews SET author_name = '${N}' WHERE user_id = $1`],
    ['operator_applications', `UPDATE operator_applications SET contact_phone = NULL, contact_email = NULL WHERE user_id = $1`],
    // Причина смены его роли — слова администратора о нём; писателя в коде
    // нет, строки — прошлые. Сама смена (была роль, стала, когда) остаётся.
    ['user_role_history', `UPDATE user_role_history SET reason = NULL WHERE user_id = $1`],
    // Его запросы мест в туре (HIS_SEAT_REQUEST) — ДО шага users: ключ к ним
    // (id в Telegram) живёт только в users. После шага operator_bookings:
    // тот нашёл брони этих запросов по их чату и привязал к аккаунту. Живых
    // запросов здесь нет — ждущий ответа держит findEraseBlockers. Имя и
    // телефон NOT NULL (1108) — заглушка и пустая строка; чат стирается, и
    // уборщик уведомлений больше не пишет человеку, удалившему аккаунт.
    ['tour_seat_requests', `UPDATE tour_seat_requests SET tourist_name = '${N}', tourist_phone = '',
        tourist_chat_id = NULL, pd_consent_ip = NULL, updated_at = NOW()
      WHERE ${HIS_SEAT_REQUEST('tour_seat_requests')}`],
    // Каналы его карточки партнёра — ДО шагов tg_conversations и users: id в
    // мессенджерах, которыми канал доказанно его, живут там (HIS_MESSENGER_IDS).
    // Удаление доходит сюда только со скрытой карточкой без живых дел
    // (partner_live_business), но в её каналы идут и напоминания CRM по
    // клиентам партнёра с их именами (lib/crm/inbox-reminders) — шли бы
    // человеку, который с платформой простился. Снимается только его канал:
    // чат команды (чужой id) остаётся и называется в ответе
    // (ERASE_STEP_LEAVES). Карточку и прочие её поля шаг не трогает
    // (ERASE_KEEP, partners.*), строки, ссылающиеся на неё, — не его
    // (ERASE_DETACH_ONLY).
    // Владелец ссылки подключения (1336: кто открыл op_ в личном чате, для
    // входа на сайт через мессенджер) — его id в MAX или Telegram, и он
    // снимается с ЛЮБОЙ карточки: ссылку он мог открыть и у карточки, которой
    // аккаунт не владеет.
    ['partners', `UPDATE partners SET
        telegram_chat_id = CASE WHEN partners.user_id = $1 AND ${OWN_TG('partners')} THEN NULL ELSE partners.telegram_chat_id END,
        max_chat_id = CASE WHEN partners.user_id = $1 AND ${OWN_MAX('partners')} THEN NULL ELSE partners.max_chat_id END,
        contacts = CASE WHEN partners.user_id = $1 AND ${OWN_TG_MIRROR('partners')} THEN partners.contacts - 'telegram_chat_id' ELSE partners.contacts END,
        telegram_owner_user_id = CASE WHEN ${OWN_LINK_TG('partners')} THEN NULL ELSE partners.telegram_owner_user_id END,
        max_owner_user_id = CASE WHEN ${OWN_LINK_MAX('partners')} THEN NULL ELSE partners.max_owner_user_id END,
        updated_at = NOW()
      FROM (${HIS_MESSENGER_IDS}) his
      WHERE (partners.user_id = $1
             AND (${OWN_TG('partners')} OR ${OWN_MAX('partners')} OR ${OWN_TG_MIRROR('partners')}))
         OR ${OWN_LINK_TG('partners')} OR ${OWN_LINK_MAX('partners')}`],
    // Предложения «открыть даты» из его диалога MAX с ботом (миграция 1315,
    // lib/operators/chat-dates): chat_id строки — копия канала карточки, и
    // шаг partners выше её не видит — строки ссылаются на карточку, а не на
    // него (ERASE_DETACH_ONLY). Тот же ключ, что у канала карточки: диалог MAX
    // доказанно его. Даты, открытые по нажатию, живут в tour_availability и
    // не трогаются; уходит журнал действия с id его диалога. ДО шагов
    // tg_conversations и users — ключи к диалогу живут там.
    ['operator_chat_date_proposals', `DELETE FROM operator_chat_date_proposals p
      USING (${HIS_MESSENGER_IDS}) his
      WHERE p.channel = 'max' AND p.chat_id = ANY(his.mx)`],
    // Действия кнопкой из его чата кабинета (миграция 1341,
    // lib/bookings/chat-owner-action): бронь своего тура в два шага. Строка
    // ссылается на карточку, а не на него (ERASE_DETACH_ONLY), но несёт id его
    // диалога и причину отклонения, написанную им. Ключ тот же, что у
    // предложений дат: его Telegram или его диалог MAX. Статус брони, который
    // он поставил, живёт в operator_bookings и не трогается. ДО шагов
    // tg_conversations и users — ключи к диалогу живут там.
    ['partner_chat_actions', `DELETE FROM partner_chat_actions a
      USING (${HIS_MESSENGER_IDS}) his
      WHERE (a.channel = 'max' AND a.chat_id = ANY(his.mx))
         OR (a.channel = 'telegram' AND a.chat_id = ANY(his.tg))`],
    // Коды «/start ABC123» из кабинета (миграция 1333, lib/partners/bind-code):
    // погашенный код хранит id чата, которым канал карточки заводили, — ту же
    // копию, что снимает шаг partners выше, и по ссылке на карточку она не его
    // (ERASE_DETACH_ONLY). Срока у строки нет: код гаснет, а id чата остался бы
    // навсегда. Ключ тот же: его Telegram или его диалог MAX; непогашенный код
    // обоих id не несёт и под ANY(...) не попадает. ДО шагов tg_conversations и
    // users — ключи к этим id живут там.
    ['messenger_bind_codes', `DELETE FROM messenger_bind_codes b
      USING (${HIS_MESSENGER_IDS}) his
      WHERE b.telegram_chat_id = ANY(his.tg) OR b.max_chat_id = ANY(his.mx)`],
    // Переписка с Кузьмичом — ДО шага users: ключ к ней (id в мессенджере)
    // живёт только в users и обнуляется там. Telegram пишет chat_id чата и
    // user_id отправителя (в личке они равны), MAX — chat_id диалога (в users
    // его нет) и user_id = users.max_user_id; ответы Кузьмича несут тот же
    // user_id, что и вопрос. Платформу различает platform: id Telegram и MAX —
    // разные пространства чисел.
    ['tg_conversations', `DELETE FROM tg_conversations t
      USING users u
      WHERE u.id = $1
        AND (
          (t.platform = 'max' AND t.user_id = u.max_user_id)
          OR (COALESCE(t.platform, 'telegram') = 'telegram'
              AND (t.user_id = u.telegram_id OR t.chat_id = u.telegram_id OR t.chat_id = u.telegram_chat_id))
        )`],
    // Сессии входа через MAX (ник и имя в MAX) — тоже до шага users.
    ['max_login_sessions', `DELETE FROM max_login_sessions
      WHERE max_user_id = (SELECT max_user_id FROM users WHERE id = $1)`],
    // Веб-чат и прежний Telegram в chat_sessions — тоже до шага users (ключ
    // 'tg_<id>' — из users). Реплики chat_messages удаляются явно, до сессий:
    // каскад внешнего ключа сделал бы это и сам, но стирание не должно
    // зависеть от того, объявлен ли ключ на проде.
    ['chat_messages', `DELETE FROM chat_messages WHERE session_id IN (${HIS_CHAT_SESSIONS})`],
    ['chat_sessions', `DELETE FROM chat_sessions WHERE id IN (${HIS_CHAT_SESSIONS})`],
    // До анкеты: ссылка tourist_id → tourist_profiles.id без внешнего ключа
    // (миграция 903). ::text с обеих сторон — тип колонки на проде этой
    // миграцией не задан (там она no-op), а сбой шага откатил бы всё удаление.
    ['tourist_documents', `DELETE FROM tourist_documents
      WHERE tourist_id::text IN (SELECT id::text FROM tourist_profiles WHERE user_id = $1)`],
    // Внешний ключ с ON DELETE CASCADE удалил бы их и так; явный шаг — чтобы
    // стирание не зависело от того, объявлен ли ключ на проде.
    ['tourist_wishlist', `DELETE FROM tourist_wishlist
      WHERE tourist_id IN (SELECT id FROM tourist_profiles WHERE user_id = $1)`],
    ['tourist_profiles', `DELETE FROM tourist_profiles WHERE user_id = $1`],
    // MAX администратора (1324) и Telegram (1330): id его человека в мессенджере
    // и одноразовые ссылки. Внешний ключ с ON DELETE CASCADE снял бы их и так;
    // явный шаг — чтобы стирание не зависело от того, объявлен ли ключ на проде.
    ['admin_max_link_tokens', `DELETE FROM admin_max_link_tokens WHERE user_id = $1`],
    ['admin_max_bindings', `DELETE FROM admin_max_bindings WHERE user_id = $1`],
    ['admin_tg_link_tokens', `DELETE FROM admin_tg_link_tokens WHERE user_id = $1`],
    ['admin_tg_bindings', `DELETE FROM admin_tg_bindings WHERE user_id = $1`],
    ['user_sessions', `DELETE FROM user_sessions WHERE user_id = $1`],
    ['users', `UPDATE users SET
        email = 'deleted-' || id::text || '@deleted.invalid',
        name = '${N}',
        password_hash = '!erased',
        phone = NULL,
        telegram_id = NULL, telegram_username = NULL, telegram_chat_id = NULL,
        max_user_id = NULL, max_username = NULL,
        mfa_secret = NULL, mfa_enabled = false,
        pd_consent_given = false, marketing_consent = false,
        pd_consent_ip = NULL,
        recommendations = NULL,
        preferences = '{}'::jsonb,
        metadata = jsonb_build_object('erased_at', NOW()::text, 'erase_reason', $2::text),
        is_active = false,
        updated_at = NOW()
      WHERE id = $1`],
  ];
  const counts: Record<string, number> = { crm_contacts_telegram_copy: telegramCopy.rowCount ?? 0 };
  const unprovenCards = new Set(early.cardIds);
  const unprovenPartners = new Set(early.partnerIds);
  for (const [table, sql] of steps) {
    if (table === 'crm_events') {
      // Второй проход — перед лентой, после всех шагов его источников (брони,
      // аренды, брони жилья, заказы мест). Склейка, пришедшая во время
      // стирания (хук или крон crm-contacts-sync, lib/crm/contacts), могла
      // положить его источник в карточку, где его к первому проходу не было,
      // — например, в карточку матери у другого партнёра. Склейка запирает
      // строку источника до записи (FOR SHARE), а шаги выше её переписывают:
      // если склейка успела раньше, шаг ждал её коммита, и её связь здесь
      // уже видна. Его связь уходит и из такой карточки, а карточка попадает
      // в счёт ответа (пункты 3 и 4 правила #2327).
      const late = await detachFromUnprovenCrmContacts(db, userId);
      for (const id of late.cardIds) unprovenCards.add(id);
      for (const id of late.partnerIds) unprovenPartners.add(id);
    }
    const res = await db.query(sql, table === 'users' ? [userId, reason] : [userId]) as { rowCount?: number };
    counts[table] = res.rowCount ?? 0;
  }
  counts[UNPROVEN_CRM_CARDS] = unprovenCards.size;
  counts[UNPROVEN_CRM_PARTNERS] = unprovenPartners.size;
  return counts;
}

/**
 * Что остаётся у человека после стирания — словами для него самого.
 * `countSql` считает строки по ссылке на человека ($1 — users.id) и
 * выполняется ПОСЛЕ шагов eraseUser в той же транзакции. `null` — к аккаунту
 * не привязано: есть ли такие строки, по человеку не узнать.
 */
export interface KeptForPerson {
  /** Что осталось: «карточка партнёра, скрытая с витрины». */
  category: string;
  /** Почему: «на неё ссылаются туры и брони…». */
  why: string;
  countSql: string | null;
}

export interface KeepEntry {
  /** Причина для ревью: чьи это данные и кто решает их судьбу. */
  reason: string;
  /**
   * Нет — перепись задела таблицу по имени колонки, а данные не этого
   * человека (название шаблона, модератор объявления): называть их ему нечего.
   */
  remains?: KeptForPerson;
}

const MONEY_WHY = 'учёт денег хранится по закону о бухгалтерском учёте';
const REVIEWS = 'тексты ваших отзывов — без вашего имени';
const REVIEWS_WHY = 'отзыв остаётся опытом поездки для других туристов, имя в нём стёрто';
const WORK_NOTES = 'рабочие заметки оператора, гида и перевозчика к вашим поездкам';
const WORK_NOTES_WHY = 'это записи их учёта о прошедших поездках';
const MONEY_NOTES = 'отметки об оплате, возвратах и комиссии по вашим броням и трансферам';
const nonEmpty = (col: string) => `NULLIF(btrim(${col}), '') IS NOT NULL`;

/**
 * Почему поля карточки партнёра хранятся. Шаг partners снимает с карточки
 * только его каналы в мессенджерах; остальное — данные бизнеса.
 */
const PARTNER_CARD_WHY = 'карточка партнёра (компания, ИП, гид) по договору, а не анкета человека; на неё ссылаются туры '
  + 'и брони; удаление проходит, только когда она скрыта с витрины и без окна чата (findEraseBlockers), а удалить её '
  + 'саму — решение владельца, не автомат (#2327). Шаг partners снимает с неё только его каналы в мессенджерах. По '
  + 'ссылкам verified_by и agent_rate_set_by это чужие карточки, которые он проверял или которым назначал ставку как администратор';

/** Поля карточки партнёра из переписи, которые шаг partners не трогает: колонка и что в ней. */
const PARTNER_CARD_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['phone', 'телефон карточки для туристов'],
  ['contact', 'контакты карточки на витрине'],
  ['description', 'описание партнёра на витрине'],
  ['short_description', 'краткое описание партнёра на витрине'],
  ['faq', 'вопросы и ответы на странице партнёра'],
  ['features', 'преимущества на странице партнёра'],
  ['services', 'услуги партнёра'],
  ['season_info', 'сезоны на странице партнёра'],
  ['reviews_data', 'отзывы на странице партнёра'],
  ['gallery', 'снимки на странице партнёра'],
  ['gallery_credits', 'авторы снимков на странице партнёра'],
  ['video_clips', 'клипы на странице партнёра'],
  ['location', 'место партнёра на карте'],
  ['widget_config', 'настройки окна чата на сайте партнёра'],
  ['legal_info', 'реквизиты юрлица или ИП'],
  ['bank_details', 'банковские реквизиты партнёра'],
  ['payout_details', 'реквизиты выплат партнёру'],
  ['commission_rules', 'правила комиссии партнёра'],
  ['consents', 'согласия партнёра по договору'],
  ['operator_info', 'сведения об операторе'],
  ['roles', 'роли партнёра на платформе'],
  ['profile_draft', 'черновик профиля партнёра на проверке'],
  ['profile_review_comment', 'комментарий администратора к профилю партнёра'],
  ['agent_rate_reason', 'основание агентской ставки, которое пишет администратор (миграция 1023)'],
];

/**
 * Что шаг eraseUser намеренно оставляет у человека вне переписи колонок — то,
 * что он трогает, но не стирает целиком, потому что не доказано, что это его.
 * Ключ — `таблица.что`; сторож требует шага по таблице (запись самоустаревает).
 * Счёт — после шагов, по ссылке на человека, как у ERASE_KEEP.
 */
export const ERASE_STEP_LEAVES: Readonly<Record<string, KeptForPerson>> = {
  // Шаг partners снимает каналы, равные его id в мессенджерах; оставшийся —
  // чужой id (группа команды, другой человек) или его диалог MAX, где он ни
  // разу не писал Кузьмичу: что он его, по столбцам не доказать, а снять
  // чужой — оборвать уведомления партнёра, решение не наше.
  'partners.channels': {
    category: 'чат Telegram или MAX вашей карточки партнёра, не совпадающий с вашим аккаунтом в мессенджере (например, чат команды)',
    why: 'по записям платформы он не ваш, и напоминания по клиентам карточки продолжают приходить туда; снять его — '
      + `решение владельца платформы по вашему обращению на ${REQUISITES.emailPrivacy}`,
    countSql: `SELECT count(*)::int AS n FROM partners WHERE user_id = $1
                 AND (telegram_chat_id IS NOT NULL OR max_chat_id IS NOT NULL
                      OR (jsonb_typeof(contacts) = 'object' AND ${nonEmpty(`contacts->>'telegram_chat_id'`)}))`,
  },
};

/**
 * Что хранится после удаления аккаунта и почему. Ключ — таблица (`table`)
 * или колонка (`table.column`) из переписи сторожа полноты
 * (tests/unit/account-erase-coverage.test.ts). Запись самоустаревает: таблица
 * пропала из переписи или её начал стирать eraseUser — сторож красный.
 */
export const ERASE_KEEP: Readonly<Record<string, KeepEntry>> = {
  accommodations: {
    reason: 'ссылка moderated_by — на модератора объявления; имя и телефон в строке — объекта размещения, а не модератора',
  },
  gear_items: {
    reason: 'ссылка moderated_by — на модератора; name — название снаряжения, а не имя человека',
  },
  'rental_offer_edits.moderation_reason': {
    reason: 'ссылка moderated_by — на администратора, который решил правку цены или описания машины; текст — причина по строке прайса, а не данные этого человека',
  },
  guide_certifications: {
    reason: 'ссылка reviewed_by — на проверявшего администратора; имя в строке — аттестованного гида из реестра, не его',
  },
  'crm_tasks.details': {
    reason: 'задача партнёра по клиенту: created_by и done_by — на человека из команды партнёра, а текст — о его клиенте, '
      + 'не о нём; по ссылке на карточку — у карточки, доказанно его, задач не бывает (PROVEN_HIS_CARD), а задачи карточки, '
      + 'которая не доказанно его, остаются с причиной (UNPROVEN_CARD_KEEP) и стираются по обращению (eraseCrmContactOnRequest)',
  },
  octo_api_keys: {
    reason: 'ссылка created_by — на создавшего ключ; name и notes — подпись и заметка ключа API, а не данные человека',
  },
  message_templates: {
    reason: 'name — название шаблона сообщения, а не имя человека',
  },
  agent_approvals: {
    reason: 'ссылка reviewed_by — на администратора, рассмотревшего действие агента платформы; заметки — о действии, а не о человеке',
  },
  operator_tours: {
    reason: 'ссылка created_by — на автора строки тура; notes, price_note, safety_notes — о туре, а не о человеке',
  },
  'sos_events.notes': {
    reason: 'служебная отметка об исходе сигнала («снят через 24ч», архив) — пишет система, а не человек; имя, телефон и адрес стираются шагом',
  },
  tour_selections: {
    reason: 'подборку собирает партнёр для СВОЕГО клиента: created_by — автор-партнёр, имя, телефон и Telegram — клиента, а не автора',
    remains: {
      category: 'подборки туров, которые вы собирали для клиентов',
      why: 'в них данные ваших клиентов, их судьбу решает владелец платформы',
      countSql: `SELECT count(*)::int AS n FROM tour_selections WHERE created_by = $1`,
    },
  },
  agent_clients: {
    reason: 'записная книжка агента: ПД его клиентов (третьих лиц), а не самого агента; что с ней делать при удалении аккаунта агента — решение владельца (#2327)',
    remains: {
      category: 'записи о ваших клиентах в кабинете агента',
      why: 'это данные ваших клиентов, их судьбу решает владелец платформы',
      countSql: `SELECT count(*)::int AS n FROM agent_clients WHERE agent_id = $1`,
    },
  },
  agent_bookings: {
    reason: 'продажа агента его клиенту: agent_id — агент, заметки — о брони клиента (третьего лица); судьба записной книжки агента — решение владельца (#2327)',
    remains: {
      category: 'продажи туров вашим клиентам в кабинете агента',
      why: 'это брони ваших клиентов у операторов',
      countSql: `SELECT count(*)::int AS n FROM agent_bookings WHERE agent_id = $1`,
    },
  },
  agent_commissions: {
    reason: 'начисление агентской комиссии — бухгалтерский след; заметка — о начислении, а не анкета человека',
    remains: {
      category: 'начисления и выплаты агентской комиссии',
      why: MONEY_WHY,
      countSql: `SELECT count(*)::int AS n FROM agent_commissions WHERE agent_id = $1`,
    },
  },
  commission_payouts: {
    reason: 'выплата агентской комиссии — бухгалтерский документ; заметка — о выплате, paid_by и rejected_by — администраторы',
    remains: {
      category: 'начисления и выплаты агентской комиссии',
      why: MONEY_WHY,
      countSql: `SELECT count(*)::int AS n FROM commission_payouts WHERE agent_id = $1`,
    },
  },
  mchs_group_registrations: {
    reason: 'уведомление МЧС о выходе группы, поданное оператором: ссылка — на оператора, экстренные контакты — участников группы',
    remains: {
      category: 'уведомления МЧС о выходе групп, поданные вами как оператором',
      why: 'это документ по всей группе, срок его хранения решает владелец платформы',
      countSql: `SELECT count(*)::int AS n FROM mchs_group_registrations WHERE operator_user_id = $1`,
    },
  },
  mchs_registrations: {
    reason: 'уведомление МЧС о выходе группы — документ оператора по всей группе (jsonb NOT NULL), а не анкета автора брони; срок хранения — решение владельца (#2327)',
    remains: {
      category: 'уведомления МЧС о выходе групп по вашим броням',
      why: 'это документ оператора по всей группе, срок его хранения решает владелец платформы',
      countSql: `SELECT count(*)::int AS n FROM mchs_registrations WHERE operator_booking_id IN (${HIS_BOOKINGS})`,
    },
  },
  operator_staff: {
    reason: 'строка штата оператора: заводит и снимает её оператор в кабинете; стирать сотрудника при удалении его аккаунта — решение владельца (#2327)',
    remains: {
      category: 'ваша запись в штате оператора',
      why: 'её ведёт и снимает оператор',
      countSql: `SELECT count(*)::int AS n FROM operator_staff WHERE user_id = $1`,
    },
  },
  'partners.name': {
    reason: `вывеска карточки — ${PARTNER_CARD_WHY}`,
    remains: {
      category: 'карточка партнёра, скрытая с витрины',
      why: 'на неё ссылаются туры и брони, удалить её — решение владельца платформы по вашему обращению',
      countSql: `SELECT count(*)::int AS n FROM partners WHERE user_id = $1`,
    },
  },
  ...Object.fromEntries(PARTNER_CARD_COLUMNS.map(([column, what]) => [
    `partners.${column}`, { reason: `${what} — ${PARTNER_CARD_WHY}` },
  ])),
  security_blocks: {
    reason: 'блокировка за злоупотребление (IP или аккаунт): мера защиты платформы, срок задаёт expires_at; снимать её удалением аккаунта нельзя',
    remains: {
      category: 'блокировка за нарушение правил',
      why: 'хранится для защиты платформы до конца срока блокировки',
      countSql: `SELECT count(*)::int AS n FROM security_blocks WHERE user_id = $1`,
    },
  },
  'tour_seat_requests.failure_reason': {
    reason: 'почему не завелась бронь по запросу мест — текст ошибки учёта платформы, который пишет код (answerSeatRequest), а не человек; имя, телефон и чат запроса стираются шагом',
  },
  guide_schedule: {
    reason: 'личный календарь гида: запись ссылается на бронь, на которую его назначил оператор; заметки — гида о выходе группы',
    remains: {
      category: WORK_NOTES,
      why: WORK_NOTES_WHY,
      countSql: `SELECT count(*)::int AS n FROM guide_schedule
                  WHERE operator_booking_id IN (${HIS_BOOKINGS}) AND (${nonEmpty('notes')} OR ${nonEmpty('safety_notes')})`,
    },
  },
  driver_schedules: {
    reason: 'расписание водителя перевозчика: заметка к рейсу пишет перевозчик для водителя; ссылка — на трансфер человека',
    remains: {
      category: WORK_NOTES,
      why: WORK_NOTES_WHY,
      countSql: `SELECT count(*)::int AS n FROM driver_schedules
                  WHERE transfer_id IN (SELECT id FROM transfers WHERE user_id = $1) AND ${nonEmpty('notes')}`,
    },
  },
  'booking_change_requests.notes': {
    reason: 'заметка оператора к запросу изменения брони (перенос, возврат) — его учёт брони, а не анкета человека',
    remains: {
      category: WORK_NOTES,
      why: WORK_NOTES_WHY,
      countSql: `SELECT count(*)::int AS n FROM booking_change_requests
                  WHERE booking_id IN (${HIS_BOOKINGS}) AND ${nonEmpty('notes')}`,
    },
  },
  transfer_transactions: {
    reason: 'денежная запись перевозчика по трансферу: заметка — о платеже, бухгалтерский след',
    remains: {
      category: MONEY_NOTES,
      why: MONEY_WHY,
      countSql: `SELECT count(*)::int AS n FROM transfer_transactions
                  WHERE transfer_id IN (SELECT id FROM transfers WHERE user_id = $1) AND ${nonEmpty('notes')}`,
    },
  },
  'booking_direct_payments.note': {
    reason: 'отметка оператора об оплате брони мимо платформы — бухгалтерский след о брони, пишет оператор',
    remains: {
      category: MONEY_NOTES,
      why: MONEY_WHY,
      countSql: `SELECT count(*)::int AS n FROM booking_direct_payments
                  WHERE booking_id IN (${HIS_BOOKINGS}) AND ${nonEmpty('note')}`,
    },
  },
  'operator_commissions.notes': {
    reason: 'заметка к начислению комиссии платформы по брони — бухгалтерский след, пишет платформа',
    remains: {
      category: MONEY_NOTES,
      why: MONEY_WHY,
      countSql: `SELECT count(*)::int AS n FROM operator_commissions
                  WHERE booking_id IN (${HIS_BOOKINGS}) AND ${nonEmpty('notes')}`,
    },
  },
  'booking_direct_payments.void_reason': {
    reason: 'почему оператор отменил свою отметку об оплате брони мимо платформы — бухгалтерский след о брони, пишет оператор',
    remains: {
      category: MONEY_NOTES,
      why: MONEY_WHY,
      countSql: `SELECT count(*)::int AS n FROM booking_direct_payments
                  WHERE booking_id IN (${HIS_BOOKINGS}) AND ${nonEmpty('void_reason')}`,
    },
  },
  'tour_payments.refund_reason': {
    reason: 'отметка администратора о возврате туристу (номер операции, подтверждение перевода — /api/admin/finance/refunds) — бухгалтерский след возврата денег',
    remains: {
      category: MONEY_NOTES,
      why: MONEY_WHY,
      countSql: `SELECT count(*)::int AS n FROM tour_payments
                  WHERE booking_id IN (${HIS_BOOKINGS}) AND ${nonEmpty('refund_reason')}`,
    },
  },
  'tour_payments.refund_due_reason': {
    reason: 'формулировка правила возврата («отменил оператор — 100%») — пишет код (computeTourRefund через recordRefundDue), а не человек',
  },
  'refund_requests.reason': {
    reason: 'причина в запросе возврата по брони старого модуля оплаты: писателя в коде нет, строки — прошлые; это денежный документ, причина в нём — к возврату денег',
    remains: {
      category: MONEY_NOTES,
      why: MONEY_WHY,
      countSql: `SELECT count(*)::int AS n FROM refund_requests
                  WHERE booking_id IN (${HIS_BOOKINGS}) AND ${nonEmpty('reason')}`,
    },
  },
  'operator_bookings.discount_reason': {
    reason: 'подпись скидки строит код из прайса тура (price.label в lib/bookings/reserve.ts), а не человек',
  },
  'accommodation_bookings.refund_reason': {
    reason: 'формулировка правила возврата за жильё — пишет код (lib/stay/refund-policy), а не человек; причину отмены словами хозяина стирает шаг',
  },
  'route_registrations.closed_reason': {
    reason: 'код исхода закрытия контроля выхода (returned или cancelled — lib/safety/trip-watch) пишет код, а не человек',
  },
  'agent_referral_links.rate_reason': {
    reason: 'основание ставки агентской комиссии пишет администратор (миграция 1005) — об условиях агента, а не анкета человека',
  },
  'operator_tour_reviews.hidden_reason': {
    reason: 'причина, по которой модератор скрыл отзыв, — решение о тексте отзыва (сам текст назван человеку среди отзывов), а не анкета человека',
  },
  'carrier_reviews.hidden_reason': {
    reason: 'причина, по которой администратор скрыл отзыв о перевозчике (CHECK требует её у скрытого) — решение о тексте отзыва, а не анкета человека',
  },
  'users.blocked_reason': {
    reason: 'причина блокировки аккаунта за нарушение (lib/agents/execution) — мера защиты платформы, как security_blocks; остальное в строке стирается шагом',
    remains: {
      category: 'отметка о блокировке вашего аккаунта и её причина',
      why: 'это след меры защиты платформы',
      countSql: `SELECT count(*)::int AS n FROM users WHERE id = $1 AND ${nonEmpty('blocked_reason')}`,
    },
  },
  'operator_bookings.admin_notes': {
    reason: 'отметка платформы о проверке брони (флаг подозрительной оплаты, lib/agents/execution) — след проверки, хранится для защиты',
    remains: {
      category: 'отметки платформы о проверке ваших броней',
      why: 'это след проверки на мошенничество, он хранится для защиты платформы',
      countSql: `SELECT count(*)::int AS n FROM operator_bookings WHERE id IN (${HIS_BOOKINGS}) AND ${nonEmpty('admin_notes')}`,
    },
  },
  'place_safety_reports.note': {
    reason: 'наблюдение о состоянии места («мост смыт») — предупреждение другим туристам о месте; имени автора в строке нет',
    remains: {
      category: 'ваши наблюдения о состоянии мест',
      why: 'это предупреждение другим туристам о месте, без вашего имени',
      countSql: `SELECT count(*)::int AS n FROM place_safety_reports WHERE user_id = $1 AND ${nonEmpty('note')}`,
    },
  },
  trail_reports: {
    reason: 'наблюдение о тропе из открытой формы (POST /api/safety/reports): форма анонимная и user_id не пишет с первой версии (#294) — по человеку строку не найти; текст и точка — предупреждение другим',
    remains: {
      category: 'наблюдения о тропах, отправленные открытой формой',
      why: 'форма анонимная, к аккаунту они не привязаны, найти их по вам нельзя',
      countSql: null,
    },
  },

  // ── Вторая перепись: свободный текст и jsonb ─────────────────────────────
  'sos_events.lat': {
    reason: 'место и время сигнала SOS — след спасательной работы для разбора происшествий; имя, телефон, адрес, браузер и текст сигнала стираются шагом; стирать и точку — решение владельца (#2327)',
    remains: {
      category: 'место и время ваших сигналов SOS — без имени, телефона и текста',
      why: 'это след спасательной работы, он хранится для разбора происшествий',
      countSql: `SELECT count(*)::int AS n FROM sos_events WHERE user_id = $1 AND (lat IS NOT NULL OR lng IS NOT NULL)`,
    },
  },
  'sos_events.lng': {
    reason: 'вторая координата сигнала SOS — та же запись, что sos_events.lat; человеку она названа там, здесь не считается дважды',
  },
  'audit_logs.details': {
    reason: 'что сделано и над чем в журнале аудита — след для защиты платформы; адрес и браузер стираются шагом. Пишет журнал '
      + 'стирание карточки CRM по обращению (POST /api/admin/crm/contacts/[id]/erase): строка — администратора, details — номер '
      + 'и дата обращения и партнёр, без ПД человека, чью карточку стёрли (основание структурное, без свободного текста)',
    remains: {
      category: 'записи журнала аудита о ваших действиях — без адреса и браузера',
      why: 'это след для защиты платформы',
      countSql: `SELECT count(*)::int AS n FROM audit_logs WHERE user_id = $1 AND details IS NOT NULL AND details <> '{}'::jsonb`,
    },
  },
  'reviews.comment': {
    reason: 'текст отзыва о месте или туре — опыт поездки для других туристов; имя автора стирается шагом, текст остаётся без подписи',
    remains: {
      category: REVIEWS,
      why: REVIEWS_WHY,
      countSql: `SELECT count(*)::int AS n FROM reviews WHERE user_id = $1 AND ${nonEmpty('comment')}`,
    },
  },
  'operator_tour_reviews.comment': {
    reason: 'текст отзыва о туре оператора — опыт поездки для других туристов; имя и город автора стираются шагом',
    remains: {
      category: REVIEWS,
      why: REVIEWS_WHY,
      countSql: `SELECT count(*)::int AS n FROM operator_tour_reviews WHERE user_id = $1 AND ${nonEmpty('comment')}`,
    },
  },
  'carrier_reviews.comment': {
    reason: 'текст отзыва о перевозчике (доказанная поездка, §14) — опыт для других туристов; имя автора стирается шагом',
    remains: {
      category: REVIEWS,
      why: REVIEWS_WHY,
      countSql: `SELECT count(*)::int AS n FROM carrier_reviews WHERE user_id = $1 AND ${nonEmpty('comment')}`,
    },
  },
  guide_reviews: {
    reason: 'отзыв о гиде: имени автора в строке нет (tourist_id — ссылка на аккаунт), текст — опыт поездки для других туристов',
    remains: {
      category: REVIEWS,
      why: REVIEWS_WHY,
      countSql: `SELECT count(*)::int AS n FROM guide_reviews WHERE tourist_id = $1 AND ${nonEmpty('comment')}`,
    },
  },
  accommodation_reviews: {
    reason: 'отзыв о жилье: имени автора в строке нет, текст — опыт поездки для других туристов',
    remains: {
      category: REVIEWS,
      why: REVIEWS_WHY,
      countSql: `SELECT count(*)::int AS n FROM accommodation_reviews WHERE user_id = $1 AND ${nonEmpty('comment')}`,
    },
  },
  transfer_reviews: {
    reason: 'отзыв о трансфере старого модуля: имени автора в строке нет, текст — опыт поездки для других туристов',
    remains: {
      category: REVIEWS,
      why: REVIEWS_WHY,
      countSql: `SELECT count(*)::int AS n FROM transfer_reviews WHERE user_id = $1 AND ${nonEmpty('comment')}`,
    },
  },
  user_place_photos: {
    reason: 'снимок места, присланный для его карточки с отдельным согласием на публикацию (publish_consent_at), подпись и вердикт проверки снимка; снимать опубликованное при удалении аккаунта — решение владельца (#2327)',
    remains: {
      category: 'ваши снимки мест и подписи к ним',
      why: 'снимок, присланный для карточки места, хранится у платформы; снять его можно по обращению к владельцу платформы',
      countSql: `SELECT count(*)::int AS n FROM user_place_photos WHERE user_id = $1`,
    },
  },
  client_communications: {
    reason: 'старая переписка по броням таблицы bookings: писателя и читателя в коде нет; строка — разговор двух сторон, и стирать половину разговора — решение владельца (#2327)',
    remains: {
      category: 'старая переписка по броням',
      why: 'это разговор двух сторон, его судьбу решает владелец платформы',
      countSql: `SELECT count(*)::int AS n FROM client_communications WHERE sender_id = $1 OR recipient_id = $1`,
    },
  },
  'operator_applications.description': {
    reason: 'описание компании в заявке в операторы — о бизнесе, а не о человеке; контакты заявки стираются шагом',
  },
  'operator_applications.review_comment': {
    reason: 'комментарий администратора к заявке в операторы — решение по заявке компании, а не анкета человека',
  },
  bookings: {
    reason: 'старая таблица броней до operator_bookings: писать в неё запрещено (tests/unit/compat-view-writes), читать — CLAUDE.md §4; пожелания из живых броней стирает шаг operator_bookings, судьба старых строк — вместе с таблицей',
  },
  collections: {
    reason: 'подборка мест на витрине: created_by — куратор (администратор), описание — о местах, а не о человеке',
  },
  content_translations: {
    reason: 'перевод текста тура или места: reviewed_by — проверявший администратор, текст — о туре или месте',
  },
  loyalty_transactions: {
    reason: 'описание операции с баллами пишет система («начислено за бронь»), а не человек; писателя в коде сейчас нет',
  },
  octo_booking_log: {
    reason: 'журнал обмена с площадкой-перепродавцом (OCTO): брони реселлера заводятся без ссылки на аккаунт (lib/octo/service.ts), у человека с аккаунтом таких строк нет; срок хранения журнала с контактом покупателя реселлера — решение владельца (#2327)',
  },
  octo_webhook_log: {
    reason: 'журнал уведомлений площадке-перепродавцу (OCTO) по её броням: ссылки на аккаунт у таких броней нет, как и в octo_booking_log',
  },
  operator_payouts: {
    reason: 'выплата оператору: created_by — администратор, реквизиты — партнёра (компании), а не человека',
  },
  operator_settings: {
    reason: 'настройки кабинета оператора (автоподтверждение, политика отмены, валюта) — о бизнесе, а не о человеке',
  },
  safety_alerts: {
    reason: 'предупреждение об обстановке в крае: created_by — администратор, текст — об обстановке, а не о человеке',
  },
};

/**
 * Что этим удалением не затронуто, потому что к аккаунту не привязано:
 * строки без ссылки на человека, и найти их по нему нельзя. Не перепись —
 * список, и ведётся руками: таблица без ссылки на человека для переписи
 * невидима. Называется человеку в ответе каждый раз — он мог оставить их и
 * не помнить. Запись самоустаревает по таблице: таблицы нет в схеме — сторож
 * красный.
 */
export const ERASE_UNLINKED: Readonly<Record<string, RemainingCategory & { tables: readonly string[]; reason: string }>> = {
  anonymous_chat: {
    tables: ['chat_sessions'],
    category: 'разговоры с Кузьмичом без входа в аккаунт — на сайте и в окне чата на сайтах партнёров, '
      + 'в том числе начатые до входа и не продолженные после него',
    why: 'к аккаунту они не привязаны, найти их по вам нельзя; не привязаны и прежние разговоры, '
      + 'продолженные после входа до того, как платформа стала их привязывать',
    reason: 'веб-чат до входа и чат виджета (widget_<партнёр>_…) пишут строку без user_id; ключ сессии живёт только в браузере человека. '
      + 'Сессию, продолженную после входа, привязывает к аккаунту saveChatSession (lib/kuzmich/chat-session-save) — но только с этой правки: '
      + 'строки, продолженные раньше, остались с user_id NULL при is_authenticated = true, и чьи они, не записано нигде',
  },
  seat_requests: {
    tables: ['tour_seat_requests'],
    category: 'запросы мест в туре, оставленные без входа в аккаунт и не подключённые к вашему Telegram',
    why: 'к аккаунту они не привязаны, найти их по вам нельзя',
    reason: 'запрос мест оставляют без входа (форма, чат, MCP) — ссылки на аккаунт у него нет. С человеком его связывает только кнопка «Старт» в Telegram '
      + '(bindTouristChat: tourist_chat_id = его id в Telegram) — такие стирает шаг tour_seat_requests, а их брони — шаг operator_bookings (HIS_BOOKINGS). '
      + 'Запрос с ответом по телефону ничем, кроме телефона, не связан, а чат MAX — id диалога, которого в users нет',
  },
  messenger_bookings: {
    tables: ['operator_bookings'],
    category: 'брони, которые Кузьмич принял в MAX, и брони из Telegram, если Telegram не привязан к аккаунту',
    why: 'к аккаунту они не привязаны, найти их по вам нельзя',
    reason: 'createBooking (lib/kuzmich/core) ищет аккаунт только в Telegram и только по привязанному telegram_id: в MAX user_id брони пуст всегда, '
      + 'а метка metadata.tg_chat_id — id диалога MAX, которого в users нет (max_user_id — id человека, не диалога); бронь из Telegram, '
      + 'не привязанного к аккаунту, ничем с ним не связана. Брони из привязанного Telegram стирает шаг operator_bookings (HIS_BOOKINGS)',
  },
  trip_watches: {
    tables: ['route_registrations', 'route_registration_notifications'],
    category: 'контроли маршрута, поставленные в чате Кузьмича в MAX или формой регистрации маршрута без входа в аккаунт',
    why: 'к аккаунту они не привязаны, найти их по вам нельзя (удалить закрытые можно по обращению на '
      + `${REQUISITES.emailPrivacy} — назовите номер телефона, который указали в контроле)`,
    reason: 'контроль из чата Кузьмича в MAX (lib/kuzmich/watch-flow.ts, createTripWatch с userId: null) и форма /register '
      + 'без входа (app/api/safety/register) пишут регистрацию без user_id: с человеком её связывают телефон руководителя и '
      + 'id диалога MAX, которых в users нет (max_user_id — id человека, не диалога); шаги route_registrations и '
      + 'route_registration_notifications берут только регистрации с его user_id. Открытый такой контроль ведёт сторож, '
      + 'поэтому по обращению — только закрытые',
  },
  requests: {
    tables: ['leads', 'stay_requests'],
    category: 'заявки на подбор тура, на машину и на жильё, оставленные формой или в чате',
    why: 'к аккаунту они не привязаны, это заявки у менеджера и партнёров',
    reason: 'заявки (lib/leads/create.ts, lib/stay/stay-request-service.ts) пишутся без user_id: имя и телефон — из формы; стирать живую заявку оператору при удалении аккаунта — решение владельца (#2327)',
  },
};

export interface RemainingCategory { category: string; why: string }

/** «партнёра» после 1, 21, 31…, иначе «партнёров»: «у 1 партнёра», «у 2 партнёров». */
const partnersWord = (n: number): string => (n % 10 === 1 && n % 100 !== 11 ? 'партнёра' : 'партнёров');

/**
 * Строка ответа о карточках CRM, которые не доказанно его
 * (detachFromUnprovenCrmContacts). Только то, что код знает: карточки
 * остались, его источники по столбцу — брони, аренды, заказы мест — от них
 * отвязаны, а заявки из формы и чата к аккаунту не привязаны и, если были в
 * карточке, остались в ней (ERASE_UNLINKED.requests); имя, телефон, почта и записи
 * партнёра о клиенте (всё, что держит UNPROVEN_CARD_KEEP) МОГЛИ быть его или
 * о нём — и платформа не отличит его от другого клиента с тем же номером или
 * почтой. Ни «ваше имя снято», ни «там другой клиент»: ни того, ни другого
 * код не доказывает (§4.0). Куда написать — почта по вопросам ПД из
 * реквизитов (политика конфиденциальности): кабинета у человека после
 * удаления уже нет, а найти карточки по нему можно только по номеру и почте,
 * которые он назовёт сам. Исполнитель обещания — администратор
 * (eraseCrmContactOnRequest, POST /api/admin/crm/contacts/[id]/erase), и
 * ответ обещает ровно то, что тот стирает: поля и записи партнёра в карточке,
 * но не связанные с ней заявки — среди них могут быть заявки другого клиента
 * с тем же номером. Нет таких карточек — строки нет.
 */
export function unprovenCrmSentence(crm: UnprovenCrm): string | null {
  if (crm.cards <= 0) return null;
  const one = crm.cards === 1;
  return `У ${crm.partners} ${partnersWord(crm.partners)} ${one ? 'осталась карточка клиента' : 'остались карточки клиентов'}, `
    + 'где были и ваши заявки. Имя, телефон, почта, адрес, с которого дано согласие, и записи партнёра о клиенте '
    + `(заметки, метки, задачи, отметки о звонках, встречах и выполненных задачах) в ${one ? 'ней' : 'них'} могли быть `
    + 'вашими или о вас — по общему номеру '
    + 'телефона или почте мы не можем отличить вас от другого клиента, поэтому чужое не стираем. '
    + `Ваши брони, аренды и заказы мест от ${one ? 'неё' : 'них'} отвязаны; заявки, оставленные формой или в чате, к аккаунту `
    + `не привязаны, и если они были в ${one ? 'ней' : 'них'}, то там и остались. `
    + `Чтобы удалить ${one ? 'её' : 'их'}, напишите на ${REQUISITES.emailPrivacy} `
    + 'и укажите номер телефона и почту, с которыми бронировали: администратор платформы найдёт карточки по ним, сверит '
    + 'с вами и сотрёт в них имя, телефон, почту и записи партнёра. Сами заявки это не стирает: имя и телефон, '
    + 'записанные в заявке, остаются у партнёра.';
}

/**
 * Что остаётся в карточке CRM, которая не доказанно его
 * (detachFromUnprovenCrmContacts), — с причиной. Ключ — колонка
 * (`table.column`), таблица или вид событий ленты (`crm_events.<kind>`): ленту
 * путь трогает (уводит и обезличивает его события), но не всю — остаются
 * строки отдельных видов, и счёт по таблице их бы не увидел. Отдельно от
 * ERASE_KEEP, потому что у карточки, доказанно его, шаги eraseUser то же
 * стирают. Причина у всех одна: доказать, что поле пришло от него, а не от
 * другого клиента с тем же номером, нечем, а стереть — стереть, возможно,
 * чужое; ответ говорит это человеку (unprovenCrmSentence).
 * Сторожа: account-erase-coverage исполняет путь на заглушке (колонка ПД
 * карточки, которую путь не переписывает, и таблица CRM, которую он не
 * трогает, обязаны стоять здесь); pg-тест кладёт в такую карточку событие
 * каждого рукописного вида (HAND_TITLE_KINDS) — вид, чьё событие пережило
 * удаление нетронутым, обязан стоять здесь, а запись о виде, которое путь уже
 * обезличивает, — красная.
 */
const CARD_FIELD_KEEP = 'поле карточки клиента, где кроме его источников есть чужие записи или записи партнёра: склейка пишет '
  + 'в карточку первое пришедшее (lib/crm/contacts), и пришло ли оно от него или от другого клиента с тем же номером, '
  + 'по строке не доказать; стереть — стереть, возможно, данные другого клиента';
const TOUCH_KEEP = 'касание партнёра в ленте карточки, которая не доказанно его (addContactTouch: источника нет, '
  + 'заголовок и текст пишет партнёр — «звонил Иван, у мамы диабет»): о ком оно, по строке не различить; карточка '
  + 'с касанием доказанно его не бывает (PROVEN_HIS_CARD), стереть его можно по обращению (eraseCrmContactOnRequest)';
export const UNPROVEN_CARD_KEEP: Readonly<Record<string, string>> = {
  'crm_contacts.display_name': CARD_FIELD_KEEP,
  'crm_contacts.phone': CARD_FIELD_KEEP,
  'crm_contacts.phone_e164': CARD_FIELD_KEEP,
  'crm_contacts.email': CARD_FIELD_KEEP,
  'crm_contacts.email_norm': CARD_FIELD_KEEP,
  'crm_contacts.pd_consent_ip': `${CARD_FIELD_KEEP}; отметка согласия — того, чья запись первой её принесла`,
  // Метки (tags) остаются по той же причине, что заметка; перепись их ПД не
  // считает (массив меток — не колонка с именем ПД), поэтому записи им нет.
  'crm_contacts.notes': 'заметка партнёра о клиенте карточки («аллергия на орехи, взять эпипен»): партнёр писал её о '
    + 'человеке, которого знает, и о ком она — о нём или о другом клиенте с тем же номером — по строке не различить',
  crm_tasks: 'задачи партнёра по клиенту карточки («позвонить про эпипен») — его работа с клиентом, о ком она — по '
    + 'строке не различить; карточка с задачей доказанно его не бывает (PROVEN_HIS_CARD), стереть её можно по обращению '
    + '(eraseCrmContactOnRequest)',
  'crm_events.note': TOUCH_KEEP,
  'crm_events.call': TOUCH_KEEP,
  'crm_events.meeting': TOUCH_KEEP,
  'crm_events.task_done': 'отметка партнёра «задача выполнена» в ленте карточки, которая не доказанно его (заголовок — '
    + 'текст задачи, lib/crm/tasks): работа партнёра с клиентом, о ком она — по строке не различить; карточка с такой '
    + 'отметкой доказанно его не бывает (PROVEN_HIS_CARD), по обращению заголовок становится подписью рода '
    + '(eraseCrmContactOnRequest)',
};

export interface RemainingData {
  /** Осталось у человека — сосчитано по ссылке на него. */
  kept: Array<RemainingCategory & { count: number }>;
  /** Счёт не выполнился: осталось ли, мы не знаем (§4.0, «не смог проверить»). */
  unchecked: RemainingCategory[];
  /** К аккаунту не привязано: есть ли такие строки, по человеку не узнать. */
  unlinked: RemainingCategory[];
  /** Карточки CRM, которые не доказанно его: остались у партнёров (unprovenCrmSentence). */
  crm: UnprovenCrm;
}

/**
 * Что из ERASE_KEEP и ERASE_STEP_LEAVES осталось у человека. Вызывать в транзакции удаления,
 * ПОСЛЕ eraseUser: каждый счёт — под своей точкой сохранения, чтобы отказ
 * одного счёта (таблицы нет на проде, сбой) не откатил стирание, а стал
 * исходом «не смог проверить», названным человеку. `erased` — счёт, который
 * вернул eraseUser: карточки CRM, которые не доказанно его
 * (UNPROVEN_CRM_CARDS, UNPROVEN_CRM_PARTNERS), после стирания по человеку
 * уже не найти.
 */
export async function findRemainingData(
  db: EraseQueryable,
  userId: string,
  erased: Readonly<Record<string, number>> = {},
): Promise<RemainingData> {
  const kept = new Map<string, RemainingCategory & { count: number }>();
  const unchecked = new Map<string, RemainingCategory>();
  const unlinked = new Map<string, RemainingCategory>();
  const remains: Array<[string, KeptForPerson | undefined]> = [
    ...Object.entries(ERASE_KEEP).map(([key, entry]): [string, KeptForPerson | undefined] => [key, entry.remains]),
    ...Object.entries(ERASE_STEP_LEAVES),
  ];
  for (const [key, r] of remains) {
    if (!r) continue;
    const { category, why } = r;
    if (r.countSql === null) { unlinked.set(category, { category, why }); continue; }
    await db.query('SAVEPOINT erase_remains');
    let n: number;
    try {
      const { rows } = await db.query(r.countSql, [userId]);
      n = Number(rows[0]?.n ?? 0);
      await db.query('RELEASE SAVEPOINT erase_remains');
    } catch (err) {
      logSwallowedFailure('account/erase', `счёт оставшегося «${key}»`, err);
      await db.query('ROLLBACK TO SAVEPOINT erase_remains');
      unchecked.set(category, { category, why });
      continue;
    }
    if (n > 0) {
      const prev = kept.get(category);
      kept.set(category, { category, why, count: (prev?.count ?? 0) + n });
    }
  }
  for (const c of kept.keys()) unchecked.delete(c);
  for (const { category, why } of Object.values(ERASE_UNLINKED)) unlinked.set(category, { category, why });
  const crm: UnprovenCrm = { cards: erased[UNPROVEN_CRM_CARDS] ?? 0, partners: erased[UNPROVEN_CRM_PARTNERS] ?? 0 };
  return { kept: [...kept.values()], unchecked: [...unchecked.values()], unlinked: [...unlinked.values()], crm };
}

/**
 * Ответ человеку на удаление: не больше, чем сделано. «Стёрты» — только если
 * у него ничего не осталось, всё удалось проверить и ни одной карточки CRM,
 * которая не доказанно его, нет; иначе — что осталось и почему, какие
 * карточки CRM остались и куда написать, чего проверить не удалось, и что к
 * аккаунту не привязано вовсе.
 */
export function erasureMessage(rem: RemainingData): string {
  const parts: string[] = [];
  const crm = unprovenCrmSentence(rem.crm);
  if (rem.kept.length === 0 && rem.unchecked.length === 0 && crm === null) {
    parts.push('Аккаунт удалён, персональные данные стёрты.');
  } else {
    // Имя, телефон и почта могли остаться в том, что названо ниже (карточка
    // CRM, которая не доказанно его, карточка партнёра), а чат карточки
    // партнёра, который не доказанно его, — тоже привязка Telegram или MAX
    // (ERASE_STEP_LEAVES): первая фраза не говорит «стёрты» о них без оговорки.
    parts.push('Аккаунт удалён: документы стёрты; имя, телефон, почта и привязки Telegram и MAX — везде, кроме названного ниже.');
    if (rem.kept.length > 0) {
      parts.push(`Осталось: ${rem.kept.map((k) => `${k.category} — ${k.why}`).join('; ')}.`);
    }
    if (crm !== null) parts.push(crm);
    if (rem.unchecked.length > 0) {
      parts.push(`Не удалось проверить, осталось ли: ${rem.unchecked.map((k) => k.category).join('; ')}.`);
    }
  }
  for (const u of rem.unlinked) {
    parts.push(`${u.category[0].toUpperCase()}${u.category.slice(1)}: ${u.why}, это удаление их не затронуло.`);
  }
  return parts.join(' ');
}
