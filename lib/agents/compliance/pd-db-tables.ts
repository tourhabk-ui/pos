/**
 * Сторож ПД, сток «база»: в какие таблицы код пишет имя и телефон человека и
 * что потом с этими строками происходит (слово владельца 16.11 «го»).
 *
 * Повод — ревью #3460: разведка по группам Telegram клала в
 * `kamchatka_routes.metadata.sample` подписи и слова людей из группы как есть.
 * Таблица — публичный каталог маршрутов, срока хранения у неё нет, и ни одна
 * уборка о ней не знала. Сторож логов и Telegram этого не видел: запись в базу
 * стоком не считалась.
 *
 * Теперь каждый запрос, который пишет (`INSERT INTO`, `UPDATE … SET`) и несёт
 * в параметрах поле ПД, отдаёт находку с таблицей (`pd-sinks.ts`). Здесь —
 * что с этим делать:
 *
 *   1. Публичный контент (`PUBLIC_CONTENT_TABLES`) ПД не принимает вовсе:
 *      находка там — нарушение, записью в реестре её не разрешить.
 *   2. Каждая другая таблица с ПД записана в `PD_TABLES`: что в ней лежит и как
 *      строки уходят. Род хранения не объявляется, а сверяется с механизмами:
 *        - `purge` — уборка сроков удаляет или обезличивает строки
 *          (`PURGE_STEPS`, lib/legal/retention-purge.ts);
 *        - `measured` — срок назван, перепись считает строки за сроком, но
 *          удаления по сроку нет (`RETENTION_TARGETS`, retention-census.ts);
 *        - `erase` — срока нет, строки стирает удаление аккаунта человека
 *          (шаг `eraseUser`, lib/account/erase.ts);
 *        - `gap` — ни одного из трёх; причина обязательна. Запись краснеет,
 *          когда механизм появился: пробел закрыт — обновите род.
 *      Род — сильнейший из найденных (purge > measured > erase > gap).
 *   3. Новая таблица с ПД без записи — красная. Запись, в которую больше никто
 *      ПД не пишет, — красная: реестр не переживает своих писателей.
 *
 * Чего сторож не видит, и это названо, а не скрыто:
 *   - свободного текста: слова человека в поле `text`/`message` по имени не
 *     узнать (их держит перепись удаления аккаунта по роду колонки);
 *   - параметров, собранных через `push` в массив, и потока дальше одного шага;
 *   - тегированных шаблонов `sql\`…\`` и записи через ORM-обёртки без `query(`;
 *   - поля сообщения, которому значение дал не этот файл: `m.from` ловится,
 *     только если сам файл положил в `from` имя (`{ from: fromName }`).
 */

/** Как строки таблицы уходят. Сверяется с механизмами, не объявляется. */
export type PdTableKept = 'purge' | 'measured' | 'erase' | 'gap';

export interface PdTableEntry {
  table: string;
  /** Что о человеке там лежит. */
  holds: string;
  kept: PdTableKept;
  /** Для `gap`: почему срока и стирания нет и где это названо. */
  why?: string;
}

/**
 * Публичный контент: каталог маршрутов, места, их переводы и снимки. Их читает
 * каждый посетитель и каждый ИИ-агент, срока хранения у них нет — ПД сюда не
 * пишутся ни с какой причиной.
 */
export const PUBLIC_CONTENT_TABLES: readonly string[] = [
  'kamchatka_routes',
  'places',
  'route_waypoints',
  'ai_route_images',
  'place_gallery_photos',
  'content_translations',
];

export const PD_TABLES: readonly PdTableEntry[] = [
  // --- уборка сроков
  { table: 'kuzmich_safety_reviews', kept: 'purge', holds: 'почта администратора, разобравшего ответ Кузьмича' },
  { table: 'mcp_write_attempts', kept: 'purge', holds: 'хэш телефона заявки ИИ-агента (не сам номер)' },
  // --- срок назван, перепись меряет
  { table: 'leads', kept: 'measured', holds: 'имя, телефон и почта человека в заявке' },
  { table: 'operator_bookings', kept: 'measured', holds: 'имя, телефон и почта туриста в брони' },
  // --- стирается удалением аккаунта
  { table: 'users', kept: 'erase', holds: 'аккаунт: имя, почта, телефон, имя из Telegram' },
  { table: 'user_sessions', kept: 'erase', holds: 'токен сессии; в его теле почта пользователя' },
  { table: 'partners', kept: 'erase', holds: 'карточка партнёра: контактное лицо, телефон и почта' },
  { table: 'operator_applications', kept: 'erase', holds: 'заявка в операторы: телефон и почта контакта' },
  { table: 'crm_contacts', kept: 'erase', holds: 'карточка клиента в CRM партнёра: телефон и почта' },
  { table: 'booking_waivers', kept: 'erase', holds: 'подписанный отказ: телефон экстренного контакта' },
  { table: 'gear_rentals', kept: 'erase', holds: 'аренда снаряжения: имя, почта и телефон клиента' },
  { table: 'reviews', kept: 'erase', holds: 'подпись автора отзыва о месте' },
  { table: 'operator_tour_reviews', kept: 'erase', holds: 'подпись автора отзыва о туре' },
  { table: 'carrier_reviews', kept: 'erase', holds: 'подпись автора отзыва о перевозчике' },
  { table: 'sos_events', kept: 'erase', holds: 'имя и телефон человека, нажавшего SOS' },
  { table: 'tg_conversations', kept: 'erase', holds: 'имя человека в разговоре с Кузьмичом в Telegram' },
  { table: 'tour_seat_requests', kept: 'erase', holds: 'запрос мест в туре: имя и телефон' },
  { table: 'transfer_seat_bookings', kept: 'erase', holds: 'заказ места в машине: телефон' },
  { table: 'support_tickets', kept: 'erase', holds: 'обращение в поддержку: имя и почта' },
  // --- пробелы: срока нет, удаление аккаунта их не стирает
  {
    table: 'agent_clients', kept: 'gap', holds: 'клиенты турагента: имя, телефон и почта',
    why: 'данные клиентов агента, а не самого агента: удаление аккаунта их оставляет и называет (ERASE_KEEP.agent_clients); срока хранения нет',
  },
  {
    table: 'tour_selections', kept: 'gap', holds: 'подборка оператора для клиента: имя и телефон клиента',
    why: 'подборку завёл оператор для своего клиента: удаление аккаунта её оставляет и называет (ERASE_KEEP.tour_selections); срока хранения нет',
  },
  {
    table: 'stay_requests', kept: 'gap', holds: 'заявка на жильё: имя и телефон гостя',
    why: 'с аккаунтом заявку связывает только ключ ссылки, а не user_id — удаление аккаунта её не находит и называет (ERASE_UNLINKED); срока хранения нет',
  },
  {
    table: 'request_messages', kept: 'gap', holds: 'переписка по заявке: слова человека и адресата, имя гостя в маске',
    why: 'часть заявки, уходит вместе с ней каскадом (ERASE_UNLINKED); у заявки на тур срок назван (leads), у заявки на жильё — нет',
  },
  {
    table: 'channel_orders', kept: 'gap', holds: 'заказ с чужой витрины: имя, почта и телефон туриста',
    why: 'заказ приходит с внешнего канала без аккаунта Ведара; ни срока, ни стирания нет — разобрать вместе с каналами продаж',
  },
  {
    table: 'outreach_queue', kept: 'gap', holds: 'очередь писем операторам: почта компании (у ИП — почта человека)',
    why: 'адрес компании с её открытой страницы; у ИП это почта человека, а срока у очереди нет',
  },
];

/** Таблицы, где действует механизм: из реестров сроков и шагов удаления аккаунта. */
export interface RetentionMechanisms {
  purge: ReadonlySet<string>;
  measured: ReadonlySet<string>;
  erase: ReadonlySet<string>;
}

/** Сильнейший механизм таблицы. */
export function keptOf(table: string, m: RetentionMechanisms): PdTableKept {
  if (m.purge.has(table)) return 'purge';
  if (m.measured.has(table)) return 'measured';
  if (m.erase.has(table)) return 'erase';
  return 'gap';
}

export interface DbFinding { file: string; line: number; sink: string; expr: string; tables?: string[] }

export interface DbCensus {
  /** ПД в публичный контент — нарушение без исключений. */
  publicContent: DbFinding[];
  /** Таблицы с ПД без записи в `PD_TABLES` — с первой находкой. */
  unregistered: Array<{ table: string; first: DbFinding; count: number }>;
  /** Записи, в чью таблицу ПД больше не пишет никто. */
  stale: PdTableEntry[];
  /** Записи, чей род разошёлся с механизмами. */
  wrongKept: Array<{ table: string; declared: PdTableKept; actual: PdTableKept }>;
}

/** Чистая сверка находок с реестром. */
export function dbCensus(
  findings: readonly DbFinding[],
  mechanisms: RetentionMechanisms,
  registry: readonly PdTableEntry[] = PD_TABLES,
): DbCensus {
  const publicSet = new Set(PUBLIC_CONTENT_TABLES);
  const known = new Map(registry.map((e) => [e.table, e]));
  const publicContent: DbFinding[] = [];
  const byTable = new Map<string, { first: DbFinding; count: number }>();
  for (const f of findings) {
    for (const t of f.tables ?? []) {
      if (publicSet.has(t)) { publicContent.push(f); continue; }
      const seen = byTable.get(t);
      if (seen) seen.count++;
      else byTable.set(t, { first: f, count: 1 });
    }
  }
  return {
    publicContent,
    unregistered: [...byTable].filter(([t]) => !known.has(t)).map(([table, v]) => ({ table, ...v })),
    stale: registry.filter((e) => !byTable.has(e.table)),
    wrongKept: registry
      .map((e) => ({ table: e.table, declared: e.kept, actual: keptOf(e.table, mechanisms) }))
      .filter((x) => x.declared !== x.actual),
  };
}
