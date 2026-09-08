/**
 * lib/agents/cron-capabilities.ts — что эндпоинт УМЕЕТ, а не безопасен ли он.
 *
 * ── Откуда правило ─────────────────────────────────────────────────────────
 *
 * Идея из разбора скиллов ИИ-агентов (дайджест 08.09): вопрос «безопасен ли
 * этот скилл» неотвечаем — судить придётся о намерении. Вопрос «что он умеет»
 * отвечаем полностью и проверяется машиной. Отсюда: не оценка, а ПЕРЕЧЕНЬ
 * возможностей, замороженный и растущий только осознанно.
 *
 * У нас это уже работает по частям и с пользой: `provider-registry` морозит
 * список LLM-хостов с юрисдикцией, `cron-schedulers` требует объявить, кто
 * запускает роут, `schema-coverage` морозит список неучтённых таблиц. Чего не
 * было — единого ответа на вопрос «что этот крон может сделать»: пишет ли он в
 * базу, ходит ли наружу, шлёт ли в Telegram, тратит ли деньги на модель,
 * касается ли платежей и персональных данных.
 *
 * Цена пробела не теоретическая. Роут, который считался переписью (read-only),
 * тихо получает запись — и об этом узнают, когда перепись что-то испортит.
 * Роут диагностики обзаводится ключом и начинает жечь токены. Ни то, ни другое
 * не видно в ревью диффа: строка добавляется в файле, который «и так про это».
 *
 * ── Почему граф, а не один файл ────────────────────────────────────────────
 *
 * Роут почти ничего не делает сам: он зовёт функцию из `lib/`. Смотреть только
 * на файл роута значило бы считать, что `GET /api/cron/rescue` ничего не умеет,
 * — при том что за ним `runRescueScan`, который шлёт в Telegram и пишет в базу.
 * Поэтому обход идёт по собственным импортам (`@/...`) вглубь.
 *
 * ── Где у статики граница, и почему она названа вслух ──────────────────────
 *
 * 24.08 уже стоило времени: первая версия сторожа приведения типов судила
 * статикой то, что делает сервер, и пометила два РАБОЧИХ запроса. Урок записан
 * в CLAUDE.md §4: судить статикой то, что выводится в рантайме, запрещено.
 *
 * Здесь статике доступно ровно перечисление употреблений — и этого хватает,
 * потому что вопрос именно такой. Но у обхода есть предел глубины, а импорт
 * может быть динамическим (`await import(...)`). Всё, до чего не дошли,
 * возвращается отдельным полем `unexplored`: это «не знаю», и оно не
 * складывается с «умеет» и не выдаётся за «не умеет» (§4.0).
 */

import {
  CONTACT_WORD,
  PERSONAL_NAME_FIELD,
  PERSONAL_OWNER_NAME,
} from '@/lib/agents/compliance/pii-flow-scanner';

/**
 * Признак персональных данных — СОБРАН из определений D1, а не написан заново.
 *
 * D1 (`pii-flow-scanner`) уже отвечает на вопрос «что здесь ПД», и отвечает
 * подробно: состав расширен по 152-ФЗ разбором 05.09 — паспорт, ИНН, СНИЛС,
 * адрес, дата рождения, идентификатор Telegram. Второй список здесь разошёлся
 * бы с первым и разошёлся бы молча.
 *
 * Разница в вопросе, не в словах: D1 спрашивает «уходят ли ПД в промпт чужой
 * модели» и потому смотрит на интерполяцию; здесь вопрос проще — «работает ли
 * этот эндпоинт с ПД вообще».
 */
const PD_MARKER = new RegExp(
  `\\.\\s*(?:[a-z0-9$]+_)*(?:${CONTACT_WORD})s?\\b`
  + `|${PERSONAL_NAME_FIELD.source}`
  + `|${PERSONAL_OWNER_NAME.source}`
  + `|\\bredactPII\\s*\\(`,
  'i',
);

/** Что эндпоинт умеет. Перечень намеренно короткий: каждый пункт — про риск. */
export type Capability =
  | 'db_read'    // читает базу
  | 'db_write'   // меняет данные
  | 'net_out'    // ходит на внешний хост
  | 'telegram'   // отправляет сообщение людям
  | 'ai'         // зовёт модель (то есть тратит деньги и время)
  | 'money'      // касается платежей, выплат, комиссий
  | 'pd_direct'; // САМ роут работает с персональными данными (см. ниже про имя)

export const ALL_CAPABILITIES: readonly Capability[] = [
  'db_read', 'db_write', 'net_out', 'telegram', 'ai', 'money', 'pd_direct',
];

/**
 * Признаки, которые считаются ТОЛЬКО в файле самого роута, без обхода импортов.
 *
 * Здесь ровно один, и он такой не по вкусу, а по замеру. Счёт роутов с ПД по
 * глубине обхода: 30 → 66 → 156 → 173 из 178. Он не стабилизируется никогда —
 * значит меряет не эндпоинт, а связность графа: почти всё, что импортируется,
 * где-то касается `chat_id` или `contacts`. Возможность, истинная у 97%
 * роутов, не сообщает ничего и создаёт вид проверки.
 *
 * Остальные признаки на той же шкале выходят на полку к глубине 2
 * (db_write 50→102→115→115, telegram 16→37→45→45, ai 5→34→45→46,
 * money 5→6→6→6) — их обходить можно и нужно.
 *
 * Поэтому не «выбросить ПД», а сузить вопрос до отвечаемого и НАЗВАТЬ это в
 * имени: `pd_direct` — «роут работает с ПД сам». Острую версию вопроса —
 * «уходят ли ПД в промпт зарубежной модели» — уже задаёт D1
 * (`pii-flow-scanner`), и дублировать её здесь нечем.
 */
const DIRECT_ONLY: readonly Capability[] = ['pd_direct'];

/**
 * Глубина обхода по умолчанию — 2, по замеру выше: на ней признаки выходят на
 * полку, а третий шаг добавляет к ним один роут из ста семидесяти восьми.
 * Больше глубины — не точнее, а ровнее: у всего окажется всё.
 */
export const DEFAULT_DEPTH = 2;

export interface CapabilityScan {
  capabilities: Capability[];
  /**
   * Модули, до которых обход не дошёл: упёрся в предел глубины или в
   * динамический импорт. Непустое поле значит «перечень неполон» — не
   * «возможностей больше нет».
   */
  unexplored: string[];
  /** Сколько своих модулей осмотрено. Для отчёта, не для вердикта. */
  visited: number;
}

/**
 * Убрать комментарии, чтобы не считать возможности по РАССКАЗУ о них.
 *
 * В этом репозитории комментарии длинные и цитируют код дословно — в них
 * полно `INSERT INTO`, `api.telegram.org` и имён провайдеров. Без вычистки
 * сторож объявил бы возможностью каждое упоминание, и перечень стал бы
 * описанием комментариев, а не кода.
 *
 * Строчные комментарии режутся только там, где `//` не часть схемы (`http://`).
 */
export function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlock
    .split('\n')
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      if (i === -1) return line;
      // Позиция найдена по группе слева — сдвигаем на неё саму.
      const cut = line[i] === '/' ? i : i + 1;
      return line.slice(0, cut);
    })
    .join('\n');
}

/** Признаки возможностей. Опираются на идиомы, которые держат другие сторожа. */
const MARKERS: ReadonlyArray<{ cap: Capability; re: RegExp }> = [
  // Запись судится по SQL-глаголу, а не по имени функции: `pool.query` одинаков
  // у чтения и записи.
  { cap: 'db_write', re: /\b(INSERT\s+INTO|UPDATE\s+[a-z_"]+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i },
  { cap: 'db_read', re: /\bpool\.query\b|\bSELECT\b[\s\S]{0,200}\bFROM\b/i },
  { cap: 'net_out', re: /\bfetch\s*\(|\brelayFetch\w*\s*\(|\bfetchWithRetry\s*\(/ },
  { cap: 'telegram', re: /api\.telegram\.org|\btgSend\w*\s*\(|\btgAlert\s*\(|\bsendPdAlert\s*\(|\bmaxSendDm\s*\(/ },
  { cap: 'ai', re: /\bcallAI\w*\s*\(|\bcallDeepSeek\w*\s*\(|\bcallOpenrouter\s*\(|\bcallAnthropic\s*\(|\bcallQwen\w*\s*\(|\bcallXai\s*\(|\bcallGemini\w*\s*\(/ },
  { cap: 'money', re: /\b(tour_payments|operator_commissions|payouts|recordCommissionFromBooking)\b/ },
  // ПД — те же слова, по которым судит D1 (`lib/agents/compliance/pii-flow-scanner`).
  // Свой второй список здесь заводить нельзя: два ответа на один вопрос
  // разойдутся, и разойдутся молча (§12).
  //
  // Первая версия этого признака ловила ЛЮБОЕ `*_name` и срабатывала у 168
  // роутов из 178 — то есть у 94%. Возможность, истинная почти везде, не
  // сообщает ничего: `source_name`, `column_name`, `file_name` персональными
  // данными не являются. Признак, который не различает, хуже отсутствующего:
  // он создаёт вид проверки.
  { cap: 'pd_direct', re: PD_MARKER },
];

/** Какие возможности видны в одном файле. Чистая функция. */
export function capabilitiesInSource(src: string): Capability[] {
  const code = stripComments(src);
  return MARKERS.filter(m => m.re.test(code)).map(m => m.cap);
}

/** Импорты из своего кода (`@/...`) — по ним и идёт обход. */
export function ownImports(src: string): string[] {
  const code = stripComments(src);
  const out = new Set<string>();
  const re = /from\s+['"]@\/([^'"]+)['"]|import\s*\(\s*['"]@\/([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const p = m[1] ?? m[2];
    if (p) out.add(p);
  }
  return [...out];
}

/** Читатель исходников: путь без расширения → текст, либо null если файла нет. */
export type SourceReader = (moduleId: string) => string | null;

/**
 * Перечислить возможности эндпоинта, пройдя его собственные импорты.
 *
 * `maxDepth` — предел, а не оптимизация: без него обход уходит во весь `lib/`
 * и перечень перестаёт что-либо различать (у всего окажется всё). То, что
 * осталось за пределом, честно возвращается в `unexplored`.
 */
export function scanCapabilities(
  entryId: string,
  read: SourceReader,
  maxDepth = DEFAULT_DEPTH,
): CapabilityScan {
  const found = new Set<Capability>();
  const seen = new Set<string>();
  const unexplored = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: entryId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (seen.has(id)) continue;
    seen.add(id);

    const src = read(id);
    if (src === null) {
      // Модуль не прочитан — это тоже «не знаю», а не «пусто».
      unexplored.add(id);
      continue;
    }

    // Признаки из DIRECT_ONLY берутся только у самого роута: за его пределами
    // они меряют граф, а не эндпоинт (замер над DIRECT_ONLY).
    for (const c of capabilitiesInSource(src)) {
      if (id !== entryId && DIRECT_ONLY.includes(c)) continue;
      found.add(c);
    }

    for (const imp of ownImports(src)) {
      if (seen.has(imp)) continue;
      if (depth + 1 > maxDepth) { unexplored.add(imp); continue; }
      queue.push({ id: imp, depth: depth + 1 });
    }
  }

  return {
    capabilities: ALL_CAPABILITIES.filter(c => found.has(c)),
    unexplored: [...unexplored].sort(),
    visited: seen.size,
  };
}

/**
 * Чем перечень отличается от объявленного.
 *
 * Возвращает ДВЕ разницы, а не одну: появившееся и исчезнувшее. Появившееся —
 * повод для ревью (роут-перепись научился писать в базу). Исчезнувшее — повод
 * почистить объявление, а не тревога.
 */
export function diffCapabilities(
  declared: readonly Capability[],
  actual: readonly Capability[],
): { gained: Capability[]; lost: Capability[] } {
  return {
    gained: actual.filter(c => !declared.includes(c)),
    lost: declared.filter(c => !actual.includes(c)),
  };
}
