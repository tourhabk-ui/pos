/**
 * Перепись таблиц с ПД человека — для сторожа полноты удаления аккаунта
 * (tests/unit/account-erase-coverage.test.ts) и сверки с настоящей базой
 * (tests/integration/tourist-cabinet.pg.test.ts).
 *
 * Схема берётся оттуда же, откуда её строит деплой: baseline прода плюс
 * миграции после границы снимка (шапка baseline, `lib/database/baseline-header`).
 * Миграции ДО границы не доигрываются: их действие уже внутри снимка, а
 * `DROP TABLE` из старой миграции поверх снимка стёр бы живую таблицу.
 *
 * Текст DDL здесь судится по смыслу (CLAUDE.md §4, «SQL, миграция — сами
 * артефакты»): какие колонки у таблицы и куда ведут её внешние ключи. Что
 * разбор ничего не теряет, проверяет pg-тест: та же перепись, снятая с
 * information_schema базы, собранной из тех же файлов, обязана совпасть.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseBaselineHeader } from '@/lib/database/baseline-header';
import { isAfterBaseline, sortMigrations } from '@/lib/database/migration-order';
import { ERASE_DETACH_ONLY } from '@/lib/account/erase';

export interface ForeignKeyRef {
  table: string;
  column: string;
  refTable: string;
}

/**
 * Род колонки, который нужен переписи: `json` — json/jsonb (и их массивы),
 * куда складывают что угодно, в том числе о человеке; `other` — прочее.
 * Точный тип переписи не нужен, а сверять с базой его пришлось бы до
 * модификатора — лишняя хрупкость.
 */
export type ColumnKind = 'json' | 'other';

export interface ParsedSchema {
  /** Таблица → её колонки и их род. Только таблицы: CREATE VIEW сюда не попадает. */
  columns: Map<string, Map<string, ColumnKind>>;
  foreignKeys: ForeignKeyRef[];
}

/** Род колонки по тексту её типа в DDL («JSONB NOT NULL DEFAULT …», «text[]»). */
export function kindOfTypeText(typeText: string): ColumnKind {
  return /^"?jsonb?\b/i.test(typeText.trim()) ? 'json' : 'other';
}

/**
 * Колонка с ПД человека. Признак — имя колонки: телефон, почта, имя человека,
 * паспорт и номер документа, дата рождения, экстренный контакт, медицинское;
 * ник и id в мессенджере (`telegram`, `telegram_username`, `telegram_handle`,
 * `max_username`, `…chat_id`, `telegram_id`, `max_user_id`); IP (`ip`,
 * `ip_address`, `pd_consent_ip`, `visitor_ip`) — адрес, с которого дано
 * согласие, тоже его; свободный текст заметок (`notes`, `note`, `…_notes`) —
 * там пишут о клиенте («Telegram: @…», «звонил с другого номера»);
 * координаты (`lat`, `lng`, `…_lat`, `last_position_lng`, `reporter_lat`) —
 * где человек был: точка контроля выхода, сигнала SOS, наблюдения; голый
 * адресат (`recipient`) — журнал доставки тревог контроля выхода пишет туда
 * телефон или почту экстренного контакта (#2327, ревью круга 10). Голое
 * `name` — тоже: у таблицы, привязанной к человеку, это может быть его имя;
 * где это название (шаблона, компании) или заметка о туре, так и пишется
 * причиной в ERASE_KEEP.
 *
 * Признак судит имя, а не таблицу: новая таблица с такой колонкой и ссылкой
 * на человека попадает в перепись сама. Чего он по имени не видит —
 * свободного текста и jsonb, — видит вторая перепись (`isFreeTextColumn`).
 */
const PD_COLUMN_RE = new RegExp([
  String.raw`^name$`,
  String.raw`^recipient$`,
  String.raw`^(?:full|first|last|middle|display|author|tourist|customer|client|guest|leader|signer|user|contact|passenger|participant|member|sender|recipient|driver|holder|payer|buyer)_name$`,
  String.raw`^patronymic$`,
  String.raw`(?:^|_)phone(?:_e164|_number)?$`,
  String.raw`(?:^|_)email(?:_norm)?$`,
  String.raw`passport`,
  String.raw`birth`,
  String.raw`(?:^|_)document_number$`,
  String.raw`^emergency_contact(?!_consent)`,
  String.raw`medical`,
  String.raw`allerg`,
  String.raw`(?:^|_)(?:telegram|whatsapp|vk|instagram)(?:_(?:username|handle|nick|login))?$`,
  String.raw`(?:^|_)username$`,
  String.raw`(?:^|_)chat_id$`,
  String.raw`^(?:telegram|tg|max|vk)_(?:user_)?id$`,
  String.raw`(?:^|_)ip(?:_address)?$`,
  String.raw`(?:^|_)notes?$`,
  String.raw`(?:^|_)(?:lat|lng|lon|latitude|longitude)$`,
].join('|'));

export function isPdColumn(column: string): boolean {
  return PD_COLUMN_RE.test(column);
}

/**
 * Вторая перепись: свободный текст и jsonb. Признак ПД по имени не видит
 * того, что человек пишет сам или что о нём складывают структурой: переписка
 * с Кузьмичом (`chat_sessions.messages`), спутники регистрации маршрута
 * (`route_registrations.group_members` — имена, телефоны, годы рождения),
 * описание маршрута, сообщения обращений, пожелания, подписи к снимкам. Имя
 * колонки тут ничего не говорит о содержимом, поэтому признак — род: любая
 * json/jsonb, и текст с именем свободного текста (сообщение, содержимое,
 * запрос, ответ, комментарий, описание, пожелания, подпись, причина —
 * `…_reason`: причину отмены брони оператор или сам турист пишет словами,
 * «турист в больнице с переломом», #2327, четвёртый круг).
 *
 * Широта намеренная: jsonb с настройками или статусами тоже попадёт в
 * перепись, и решение «это не о человеке» записывается причиной в
 * ERASE_KEEP — словами, которые видно на ревью, а не молчанием признака.
 */
const FREE_TEXT_NAME_RE = new RegExp([
  String.raw`^(?:messages?|content|payload|query|answer|text|body|details|feedback|caption)$`,
  String.raw`(?:^|_)(?:comments?|description|special_requests|group_members)$`,
  String.raw`(?:^|_)reason$`,
].join('|'));

export function isFreeTextColumn(column: string, kind: ColumnKind): boolean {
  return kind === 'json' || FREE_TEXT_NAME_RE.test(column);
}

/**
 * Колонка-ссылка на человека по имени: `user_id`, `ordered_by_user_id`,
 * `agent_user_id` и подобные — id аккаунта; `tourist_id` — id анкеты туриста
 * (tourist_profiles.id). Имя нужно потому, что внешний ключ объявлен не у
 * всех: tourist_documents.tourist_id ссылается на анкету без него
 * (миграция 903), у части таблиц baseline ключа нет вовсе.
 */
const PERSON_LINK_NAME_RE = /^(?:[a-z0-9_]+_)?user_id$|^tourist_id$/;

export function isPersonLinkColumn(column: string): boolean {
  return PERSON_LINK_NAME_RE.test(column);
}

const IDENT = String.raw`(?:public\.)?"?([a-z_][a-z0-9_]*)"?`;

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
}

/** Разбить по запятым верхнего уровня (скобки и строки учитываются). */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Тело в скобках, начиная с открывающей на позиции `open`. */
function balancedBody(s: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth === 0) return s.slice(open + 1, i); }
  }
  return null;
}

const CONSTRAINT_ITEM = /^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i;
const FK_CLAUSE = new RegExp(String.raw`FOREIGN\s+KEY\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)\s*REFERENCES\s+${IDENT}`, 'i');
const INLINE_REF = new RegExp(String.raw`\bREFERENCES\s+${IDENT}`, 'i');

function absorb(sqlRaw: string, schema: ParsedSchema): void {
  const sql = stripComments(sqlRaw);
  // Порядок внутри файла важен (CREATE, затем ALTER, затем DROP), поэтому
  // все три вида собираются одним проходом по позиции.
  const events: Array<{ at: number; run: () => void }> = [];

  const create = new RegExp(String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s*\(`, 'gi');
  for (const m of sql.matchAll(create)) {
    const table = m[1].toLowerCase();
    const body = balancedBody(sql, (m.index ?? 0) + m[0].length - 1);
    if (body === null) continue;
    events.push({ at: m.index ?? 0, run: () => {
      // CREATE TABLE IF NOT EXISTS поверх существующей таблицы база не
      // исполняет вовсе: ни колонок, ни ключей из второго тела у неё нет.
      if (schema.columns.has(table)) return;
      const cols = new Map<string, ColumnKind>();
      for (const item of splitTopLevel(body)) {
        if (CONSTRAINT_ITEM.test(item)) {
          const fk = FK_CLAUSE.exec(item);
          if (fk) schema.foreignKeys.push({ table, column: fk[1].toLowerCase(), refTable: fk[2].toLowerCase() });
          continue;
        }
        const col = /^"?([a-z_][a-z0-9_]*)"?\s+(\S[\s\S]*)$/i.exec(item);
        if (!col) continue;
        const column = col[1].toLowerCase();
        cols.set(column, kindOfTypeText(col[2]));
        const ref = INLINE_REF.exec(item);
        if (ref) schema.foreignKeys.push({ table, column, refTable: ref[1].toLowerCase() });
      }
      schema.columns.set(table, cols);
    } });
  }

  const alter = new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}([\s\S]*?);`, 'gi');
  for (const m of sql.matchAll(alter)) {
    const table = m[1].toLowerCase();
    const actions = splitTopLevel(m[2]);
    events.push({ at: m.index ?? 0, run: () => {
      for (const action of actions) {
        const fk = FK_CLAUSE.exec(action);
        if (/^ADD\b/i.test(action) && fk) {
          schema.foreignKeys.push({ table, column: fk[1].toLowerCase(), refTable: fk[2].toLowerCase() });
          continue;
        }
        const add = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s+(\S[\s\S]*)$/i.exec(action);
        if (add && !/^ADD\s+(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)\b/i.test(action)) {
          const column = add[1].toLowerCase();
          const cols = schema.columns.get(table);
          // ADD COLUMN IF NOT EXISTS по существующей колонке — no-op: тип
          // остаётся прежним.
          if (cols && !cols.has(column)) cols.set(column, kindOfTypeText(add[2]));
          const ref = INLINE_REF.exec(action);
          if (ref) schema.foreignKeys.push({ table, column, refTable: ref[1].toLowerCase() });
          continue;
        }
        const retype = /^ALTER\s+(?:COLUMN\s+)?"?([a-z_][a-z0-9_]*)"?\s+(?:SET\s+DATA\s+)?TYPE\s+(\S[\s\S]*)$/i.exec(action);
        if (retype) {
          const cols = schema.columns.get(table);
          const column = retype[1].toLowerCase();
          if (cols?.has(column)) cols.set(column, kindOfTypeText(retype[2]));
          continue;
        }
        const drop = /^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/i.exec(action);
        if (drop && !/^DROP\s+(?:CONSTRAINT|DEFAULT|NOT\s+NULL)\b/i.test(action)) {
          const column = drop[1].toLowerCase();
          schema.columns.get(table)?.delete(column);
          schema.foreignKeys = schema.foreignKeys.filter((f) => !(f.table === table && f.column === column));
          continue;
        }
        const rename = /^RENAME\s+(?:COLUMN\s+)?"?([a-z_][a-z0-9_]*)"?\s+TO\s+"?([a-z_][a-z0-9_]*)"?/i.exec(action);
        if (rename && !/^RENAME\s+TO\b/i.test(action)) {
          const [from, to] = [rename[1].toLowerCase(), rename[2].toLowerCase()];
          const cols = schema.columns.get(table);
          const kind = cols?.get(from);
          if (cols && kind !== undefined) { cols.delete(from); cols.set(to, kind); }
          for (const f of schema.foreignKeys) if (f.table === table && f.column === from) f.column = to;
          continue;
        }
        const renameTable = /^RENAME\s+TO\s+"?([a-z_][a-z0-9_]*)"?/i.exec(action);
        if (renameTable) {
          const to = renameTable[1].toLowerCase();
          const cols = schema.columns.get(table);
          if (cols) { schema.columns.delete(table); schema.columns.set(to, cols); }
          for (const f of schema.foreignKeys) {
            if (f.table === table) f.table = to;
            if (f.refTable === table) f.refTable = to;
          }
        }
      }
    } });
  }

  const dropTable = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+);/gi;
  for (const m of sql.matchAll(dropTable)) {
    const names = m[1].replace(/\b(?:CASCADE|RESTRICT)\b/gi, '').split(',')
      .map((x) => x.trim().replace(/^public\./i, '').replace(/"/g, '').toLowerCase())
      .filter((x) => /^[a-z_][a-z0-9_]*$/.test(x));
    events.push({ at: m.index ?? 0, run: () => {
      for (const t of names) {
        schema.columns.delete(t);
        schema.foreignKeys = schema.foreignKeys.filter((f) => f.table !== t);
      }
    } });
  }

  events.sort((a, b) => a.at - b.at);
  for (const e of events) e.run();
}

/** Схема из файлов репозитория: baseline + миграции после границы снимка. */
export function schemaFromRepo(root = process.cwd()): ParsedSchema {
  const baselinePath = join(root, 'lib/database/baseline/schema-baseline.sql');
  const baseline = readFileSync(baselinePath, 'utf-8');
  const header = parseBaselineHeader(baseline);
  if (header.firstAfter === null) {
    throw new Error('В шапке baseline нет границы снимка — перепись схемы не строится (§4.0)');
  }
  const firstAfter = header.firstAfter;
  const schema: ParsedSchema = { columns: new Map(), foreignKeys: [] };
  absorb(baseline, schema);
  const dir = join(root, 'migrations');
  const files = sortMigrations(readdirSync(dir).filter((f) => f.endsWith('.sql')))
    .filter((f) => isAfterBaseline(f, firstAfter));
  for (const f of files) absorb(readFileSync(join(dir, f), 'utf-8'), schema);
  return schema;
}

export interface CensusRow {
  /** Чем таблица привязана к человеку: колонка и, если есть, куда ведёт ключ. */
  links: string[];
  /** Колонки с ПД по имени (первая перепись). */
  pd: string[];
  /** Свободный текст и jsonb, которых признак ПД по имени не видит (вторая перепись). */
  free: string[];
}

/**
 * Таблицы, где лежат ПД человека, найденные по связи с ним:
 *   - сама `users`;
 *   - колонка-ссылка по имени (`isPersonLinkColumn`);
 *   - внешний ключ на `users` или на таблицу, которую стирает eraseUser
 *     (`erasedTables`): участник группы принадлежит брони туриста так же,
 *     как бронь — ему самому, реплика веб-чата — его сессии. Кроме таблиц,
 *     где шаг только снимает его id с чужой строки (ERASE_DETACH_ONLY,
 *     lib/account/erase.ts): туры и заявки, ссылающиеся на карточку
 *     партнёра, — не его оттого, что с карточки снят его мессенджер.
 * Две переписи по одной связи: колонки ПД по имени (`pd`) и свободный текст
 * с jsonb (`free`). Таблица без тех и других в перепись не входит.
 */
export function personDataCensus(schema: ParsedSchema, erasedTables: ReadonlySet<string>): Map<string, CensusRow> {
  const parents = new Set<string>(['users', ...[...erasedTables].filter((t) => ERASE_DETACH_ONLY[t] === undefined)]);
  const out = new Map<string, CensusRow>();
  for (const [table, cols] of schema.columns) {
    const names = [...cols.keys()];
    const pd = names.filter(isPdColumn).sort();
    const free = names.filter((c) => !isPdColumn(c) && isFreeTextColumn(c, cols.get(c) ?? 'other')).sort();
    if (pd.length === 0 && free.length === 0) continue;
    const links = new Set<string>();
    // users — сам человек; её max_user_id — id в мессенджере, а не ссылка.
    if (table === 'users') links.add('id');
    else for (const c of names) if (isPersonLinkColumn(c)) links.add(c);
    for (const fk of schema.foreignKeys) {
      if (fk.table === table && parents.has(fk.refTable) && fk.refTable !== table) {
        links.add(`${fk.column}->${fk.refTable}`);
      }
    }
    if (links.size === 0) continue;
    out.set(table, { links: [...links].sort(), pd, free });
  }
  return out;
}

/** Та же схема, снятая с настоящей базы: колонки таблиц, их род и внешние ключи. */
export async function schemaFromDatabase(
  db: { query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }> },
): Promise<ParsedSchema> {
  const schema: ParsedSchema = { columns: new Map(), foreignKeys: [] };
  const cols = await db.query(
    `SELECT c.table_name::text AS t, c.column_name::text AS c, c.udt_name::text AS udt
       FROM information_schema.columns c
       JOIN information_schema.tables tb
         ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
      WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'`,
  );
  for (const r of cols.rows) {
    const t = String(r.t);
    const map = schema.columns.get(t) ?? new Map<string, ColumnKind>();
    // udt массива — с подчёркиванием (_jsonb); в DDL это «jsonb[]», тот же род.
    map.set(String(r.c), /^_?jsonb?$/.test(String(r.udt)) ? 'json' : 'other');
    schema.columns.set(t, map);
  }
  const fks = await db.query(
    `SELECT cl.relname::text AS t, a.attname::text AS c, rc.relname::text AS ref
       FROM pg_constraint k
       JOIN pg_class cl ON cl.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_class rc ON rc.oid = k.confrelid
       JOIN LATERAL unnest(k.conkey) AS u(attnum) ON TRUE
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
      WHERE k.contype = 'f' AND n.nspname = 'public'`,
  );
  for (const r of fks.rows) {
    schema.foreignKeys.push({ table: String(r.t), column: String(r.c), refTable: String(r.ref) });
  }
  return schema;
}

export interface EraseStep {
  table: string;
  kind: 'update' | 'delete';
  /** Колонки, которые шаг переписывает (для DELETE — пусто: строки нет). */
  set: Set<string>;
}

/** Разобрать записи, которые функция стирания послала базе, в шаги. */
function parseSteps(sent: readonly string[], who: string): EraseStep[] {
  return sent.filter((sql) => !/^\s*(SELECT|INSERT)\b/i.test(sql)).map((sql) => {
    const del = /^\s*DELETE\s+FROM\s+([a-z_][a-z0-9_]*)\b/i.exec(sql);
    if (del) return { table: del[1].toLowerCase(), kind: 'delete' as const, set: new Set<string>() };
    const upd = /^\s*UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+([\s\S]*?)\sWHERE\s/i.exec(sql);
    if (upd) {
      const set = new Set<string>();
      for (const part of splitTopLevel(upd[2])) {
        const col = /^"?([a-z_][a-z0-9_]*)"?\s*=/i.exec(part);
        if (!col) throw new Error(`шаг ${who} не разобран: «${part}» в ${upd[1]}`);
        set.add(col[1].toLowerCase());
      }
      return { table: upd[1].toLowerCase(), kind: 'update' as const, set };
    }
    throw new Error(`шаг ${who} не разобран: ${sql.slice(0, 80)}`);
  });
}

/**
 * Шаги eraseUser — вызовом самой функции на записывающей заглушке, а не
 * чтением её исходника: что стирается, видно по SQL, который она шлёт базе.
 * Шаг, который не разобрать как UPDATE … SET … WHERE или DELETE FROM, —
 * ошибка: молча пропустить его значило бы объявить таблицу нестёртой (или
 * стёртой) по догадке. Чтение (SELECT) — не шаг: им eraseUser находит
 * карточки CRM, которые не доказанно его, до стирания; на этой заглушке оно
 * ничего не находит, и запись по найденному не уходит — тот путь пишет
 * recordDetachSteps.
 */
export async function recordEraseSteps(): Promise<EraseStep[]> {
  const { eraseUser } = await import('@/lib/account/erase');
  const sent: string[] = [];
  await eraseUser({
    query: async (text: string) => { sent.push(text); return { rows: [], rowCount: 0 } as never; },
  }, '00000000-0000-4000-8000-000000000000', 'account_deleted');
  return parseSteps(sent, 'eraseUser');
}

/**
 * Шаги пути карточки CRM, которая не доказанно его
 * (detachFromUnprovenCrmContacts), — тем же вызовом на заглушке, но заглушка
 * отдаёт одну такую карточку. Без этого путь до записи не доходит, и то, что
 * он оставляет в карточке, перепись не видела бы. Заглушка, на которой путь
 * не прошёл до конца, — ошибка, а не пустой список.
 */
export async function recordDetachSteps(): Promise<EraseStep[]> {
  const { detachFromUnprovenCrmContacts } = await import('@/lib/account/erase');
  const him = '00000000-0000-4000-8000-000000000000';
  const sent: string[] = [];
  const counts = await detachFromUnprovenCrmContacts({
    query: async (text: string) => {
      sent.push(text);
      // Оба чтения пути — запор всех карточек, где он есть, и выбор тех, что
      // не доказанно его, — отдают одну карточку.
      if (/^\s*SELECT (uc\.)?id::text AS id\b/.test(text)) {
        return { rows: [{ id: '00000000-0000-4000-8000-0000000000c1', partner_id: '00000000-0000-4000-8000-0000000000a1' }] };
      }
      return { rows: [] };
    },
  }, him);
  const steps = parseSteps(sent, 'detachFromUnprovenCrmContacts');
  if (counts.cards !== 1 || !steps.some((s) => s.table === 'crm_contact_links' && s.kind === 'delete')) {
    throw new Error('заглушка не провела путь карточки, которая не доказанно его, до записи — перепись этого пути была бы пустой');
  }
  return steps;
}
