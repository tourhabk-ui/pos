/**
 * KVERT VONA parser — авиационные цветовые коды (ACC) вулканов Камчатки.
 *
 * VONA (Volcano Observatory Notice for Aviation) — стандартный ICAO/IUGG формат
 * бюллетеня. KVERT публикует его фиксированными полями, поэтому парсинг
 * надёжен (в отличие от скрейпа HTML-каталога). Ключевое поле:
 *   `Current aviation color code: RED`  (допускается colour, любой регистр).
 *
 * Чистый модуль без сети/БД — легко тестируется на фикстурах. Сетевую выборку
 * и запись в volcano_status делает lib/agents/kvert-sync.ts.
 */

export type AccColor = 'green' | 'yellow' | 'orange' | 'red' | 'unassigned';

/** Метаданные цвета: русская подпись, severity (0-3), CSS-токен фона. */
export const ACC_META: Record<AccColor, { label: string; severity: number; token: string; short: string }> = {
  green:      { label: 'Спокоен',        severity: 0, token: 'var(--success)', short: 'Зелёный' },
  yellow:     { label: 'Повышенная активность', severity: 1, token: 'var(--warning)', short: 'Жёлтый' },
  orange:     { label: 'Высокая активность',    severity: 2, token: 'var(--accent)',  short: 'Оранжевый' },
  red:        { label: 'Опасное извержение',    severity: 3, token: 'var(--danger)',  short: 'Красный' },
  unassigned: { label: 'Код не присвоен',       severity: -1, token: 'var(--text-muted)', short: 'Не присвоен' },
};

/**
 * Свежесть наблюдения KVERT. Синк авиационных кодов может встать незаметно
 * (источник сменил формат — реальный инцидент 26.07–01.08: kscnet.ru стал
 * отдавать HTML вместо VONA, синк лежал днями при зелёном на вид статусе). Тогда
 * бейдж показывает замороженный цвет как текущий, а вулкан мог эскалировать —
 * устаревший ЗЕЛЁНЫЙ опаснее всего (под-предупреждение). Поэтому проверка
 * цвето-независима: старое наблюдение любого цвета = «сверь на KVERT».
 *
 * Порог 7 дней: KVERT выпускает сводки по действующим вулканам часто, неделя
 * без обновления — повод перепроверить, но не паниковать (мягкий nudge, не
 * ложная тревога о самом вулкане).
 */
export const VOLCANO_STALE_DAYS = 7;

/** Возраст наблюдения в днях (округл. вниз). null — даты нет/не распарсилась. */
export function volcanoObservationAgeDays(observedAt: string | null | undefined, now: number = Date.now()): number | null {
  if (!observedAt) return null;
  const t = new Date(observedAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** Устарело ли наблюдение (старше порога). null-возраст → не считаем устаревшим. */
export function isVolcanoObservationStale(observedAt: string | null | undefined, now: number = Date.now()): boolean {
  const age = volcanoObservationAgeDays(observedAt, now);
  return age != null && age >= VOLCANO_STALE_DAYS;
}

/** «N дней назад» / «сегодня» / «вчера» — человекочитаемый возраст для UI. */
export function formatObservationAge(days: number): string {
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  const mod10 = days % 10, mod100 = days % 100;
  const suffix = (mod10 === 1 && mod100 !== 11) ? 'день'
    : ((mod10 >= 2 && mod10 <= 4) && (mod100 < 10 || mod100 >= 20)) ? 'дня' : 'дней';
  return `${days} ${suffix} назад`;
}

/**
 * Алиасы имён вулканов → канонический slug (latin) + русское имя для сопоставления
 * с places.name. Покрывает основные вулканы Камчатки/Северных Курил, по которым
 * KVERT выпускает VONA. Ключи — нормализованные токены (EN и RU).
 */
const VOLCANO_ALIASES: Record<string, { slug: string; ru: string }> = {
  klyuchevskoy:  { slug: 'klyuchevskoy', ru: 'Ключевской' },
  kliuchevskoi:  { slug: 'klyuchevskoy', ru: 'Ключевской' },
  ключевской:    { slug: 'klyuchevskoy', ru: 'Ключевской' },
  sheveluch:     { slug: 'sheveluch', ru: 'Шивелуч' },
  shiveluch:     { slug: 'sheveluch', ru: 'Шивелуч' },
  шивелуч:       { slug: 'sheveluch', ru: 'Шивелуч' },
  bezymianny:    { slug: 'bezymianny', ru: 'Безымянный' },
  bezymyanny:    { slug: 'bezymianny', ru: 'Безымянный' },
  безымянный:    { slug: 'bezymianny', ru: 'Безымянный' },
  karymsky:      { slug: 'karymsky', ru: 'Карымский' },
  карымский:     { slug: 'karymsky', ru: 'Карымский' },
  tolbachik:     { slug: 'tolbachik', ru: 'Толбачик' },
  толбачик:      { slug: 'tolbachik', ru: 'Толбачик' },
  avachinsky:    { slug: 'avachinsky', ru: 'Авачинский' },
  авачинский:    { slug: 'avachinsky', ru: 'Авачинский' },
  koryaksky:     { slug: 'koryaksky', ru: 'Корякский' },
  корякский:     { slug: 'koryaksky', ru: 'Корякский' },
  mutnovsky:     { slug: 'mutnovsky', ru: 'Мутновский' },
  мутновский:    { slug: 'mutnovsky', ru: 'Мутновский' },
  gorely:        { slug: 'gorely', ru: 'Горелый' },
  горелый:       { slug: 'gorely', ru: 'Горелый' },
  kizimen:       { slug: 'kizimen', ru: 'Кизимен' },
  кизимен:       { slug: 'kizimen', ru: 'Кизимен' },
  'maly semyachik': { slug: 'maly-semyachik', ru: 'Малый Семячик' },
  'малый семячик':  { slug: 'maly-semyachik', ru: 'Малый Семячик' },
  ebeko:         { slug: 'ebeko', ru: 'Эбеко' },
  эбеко:         { slug: 'ebeko', ru: 'Эбеко' },
  alaid:         { slug: 'alaid', ru: 'Алаид' },
  алаид:         { slug: 'alaid', ru: 'Алаид' },
  chikurachki:   { slug: 'chikurachki', ru: 'Чикурачки' },
  чикурачки:     { slug: 'chikurachki', ru: 'Чикурачки' },
};

/** Убирает CAVW-код, регистр, лишние пробелы: "Klyuchevskoy (CAVW #300260)" → "klyuchevskoy". */
export function cleanVolcanoName(raw: string): string {
  return raw
    .replace(/\(.*?\)/g, '')       // (CAVW #...)
    .replace(/cavw\s*#?\s*\d+/gi, '')
    .replace(/volcano/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Канонический slug вулкана по имени из VONA (EN или RU). null — неизвестный. */
export function normalizeVolcanoName(raw: string): { slug: string; ru: string } | null {
  const cleaned = cleanVolcanoName(raw);
  if (!cleaned) return null;
  if (VOLCANO_ALIASES[cleaned]) return VOLCANO_ALIASES[cleaned];
  // Попытка по первому слову (напр. "Sheveluch volcano" уже очищено, но на всякий)
  const first = cleaned.split(' ')[0];
  if (VOLCANO_ALIASES[first]) return VOLCANO_ALIASES[first];
  return null;
}

/** Строку цвета ("RED", "Orange", "жёлтый") → AccColor. null — не распознан. */
export function parseColor(raw: string): AccColor | null {
  const s = raw.trim().toLowerCase();
  if (/green|зел[её]н/.test(s)) return 'green';
  if (/yellow|ж[её]лт/.test(s)) return 'yellow';
  if (/orange|оранж/.test(s)) return 'orange';
  if (/\bred\b|красн/.test(s)) return 'red';
  if (/unassigned|не присво/.test(s)) return 'unassigned';
  return null;
}

export interface ParsedVona {
  volcanoName: string;         // как в бюллетене
  nameSlug: string | null;     // канонический slug (или null — неизвестный вулкан)
  nameRu: string | null;       // русское имя для сопоставления с places.name
  color: AccColor;
  previousColor: AccColor | null;
  summitElevationM: number | null;
  ashHeightM: number | null;
  area: string | null;
  noticeNumber: string | null;
  observedAt: Date | null;
  summary: string | null;
}

function field(text: string, label: RegExp): string | null {
  const m = text.match(label);
  return m ? m[1].trim() : null;
}

// VONA даты: "20250807/2340Z" → Date. null если не распознано.
function parseVonaDate(raw: string | null): Date | null {
  if (!raw) return null;
  const m = raw.match(/(\d{4})(\d{2})(\d{2})\/(\d{2})(\d{2})Z/);
  if (!m) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  return isNaN(dt.getTime()) ? null : dt;
}

/** Парсит один VONA-блок. null — нет обязательных полей (вулкан + текущий цвет). */
export function parseVona(text: string): ParsedVona | null {
  const nameRaw = field(text, /Volcano:\s*(.+)/i);
  const colorRaw = field(text, /Current\s+aviation\s+colou?r\s+code:\s*(\w+)/i);
  if (!nameRaw || !colorRaw) return null;

  const color = parseColor(colorRaw);
  if (!color) return null;

  const norm = normalizeVolcanoName(nameRaw);
  const prevRaw = field(text, /Previous\s+aviation\s+colou?r\s+code:\s*(\w+)/i);
  const elevRaw = field(text, /Summit\s+Elevation:\s*([\d\s]+)\s*m/i);
  // Стандартное VONA-поле "Volcanic cloud height" либо упоминание высоты пепла в сводке.
  const ashRaw = field(
    text,
    /(?:Volcanic\s+cloud\s+height|ash\s+(?:cloud|plume|column)[^\d]*(?:height|altitude|up\s+to|rose))[^\d]*(\d[\d\s]*)\s*m/i
  );

  return {
    volcanoName: nameRaw.replace(/\(.*?\)/g, '').trim(),
    nameSlug: norm?.slug ?? null,
    nameRu: norm?.ru ?? null,
    color,
    previousColor: prevRaw ? parseColor(prevRaw) : null,
    summitElevationM: elevRaw ? parseInt(elevRaw.replace(/\s/g, ''), 10) : null,
    ashHeightM: ashRaw ? parseInt(ashRaw.replace(/\s/g, ''), 10) : null,
    area: field(text, /Area:\s*(.+)/i),
    noticeNumber: field(text, /Notice\s+Number:\s*(.+)/i),
    observedAt: parseVonaDate(field(text, /Issued:\s*(.+)/i)),
    summary: field(text, /Volcanic\s+Activity\s+Summary:\s*([\s\S]+?)(?:\n\s*\n|Volcanic\s+cloud|Remarks:|Contacts:|$)/i),
  };
}

/**
 * Разбивает поток из нескольких VONA-бюллетеней и парсит каждый.
 * Разделитель — заголовок VONA. Возвращает только распознанные блоки.
 */
export function parseVonaFeed(text: string): ParsedVona[] {
  const blocks = text.split(/(?=VOLCANO\s+OBSERVATORY\s+NOTICE\s+FOR\s+AVIATION)/i);
  const out: ParsedVona[] = [];
  for (const b of blocks) {
    const parsed = parseVona(b);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ── Сводная таблица кодов ────────────────────────────────────────────────────

/**
 * Второй формат KVERT: недельный выпуск со сводкой кодов вместо блоков VONA.
 *
 * С 28.07.2026 лента отдаёт страницу, где вместо отдельных бюллетеней стоит
 * общая таблица, а вулканы сгруппированы по цвету:
 *
 *   SUMMARY OF AVIATION COLOUR CODES:
 *    KAMCHATKA
 *   SHEVELUCH: <span id='ORANGE'>ORANGE</span>
 *   BEZYMIANNY, KRASHENINNIKOV: <span id='YELLOW'>YELLOW</span>
 *   AVACHINSKY, ..., KLYUCHEVSKOY, ...: <span id='GREEN'>GREEN</span>
 *
 * Поля `Current aviation colour code:` в ней нет вовсе — по нему и искал
 * прежний парсер, поэтому распознавал ноль и синк падал тринадцать дней подряд.
 *
 * Разбор нарочно консервативен: строкой кодов считается только та, где справа
 * от двоеточия стоит ОДНО цветовое слово, а слева — прописные латинские имена
 * через запятую. Прочий текст выпуска (а его сотни килобайт: контакты, правила
 * цитирования, описания активности) под это не подходит и молча пропускается.
 * Ошибиться в сторону «не распознал» здесь дешевле: нераспознанное видно по
 * fetched: 0, а выдуманный код вулкана не видно никак.
 */
export function parseAccSummary(html: string): ParsedVona[] {
  const marker = /SUMMARY\s+OF[\s\S]{0,120}?AVIATION\s+COLOU?R\s+CODES/i;
  const at = html.search(marker);
  if (at < 0) return [];

  // Дата выпуска ищется ДО сводки — она стоит в шапке: «August 06, 2026,
  // 23:53 UTC». Без неё запись легла бы без отметки о наблюдении, и проверка
  // устаревания (VOLCANO_STALE_DAYS) не смогла бы сказать, что коды старые.
  const observedAt = parseReleaseDate(html.slice(Math.max(0, at - 4000), at));

  // Сводка занимает несколько строк сразу за маркером; берём с запасом и
  // останавливаемся на первой же строке, которая под формат не подходит,
  // но только после того, как хотя бы одна строка кодов уже нашлась.
  const lines = stripTags(html.slice(at)).split('\n');

  const out: ParsedVona[] = [];
  const seen = new Set<string>();
  let started = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const m = /^([A-Z][A-Z\s,'’.\-()]{2,600}?):\s*(GREEN|YELLOW|ORANGE|RED|UNASSIGNED)\s*$/.exec(line);
    if (!m) {
      // Заголовки районов («KAMCHATKA», «NORTHERN KURILES») внутри сводки —
      // не конец таблицы.
      if (started && /^[A-Z][A-Z\s]{2,40}$/.test(line)) continue;
      if (started) break;
      continue;
    }
    started = true;

    const color = parseColor(m[2]);
    if (!color) continue;

    for (const nameRaw of m[1].split(',')) {
      const volcanoName = nameRaw.trim();
      if (!volcanoName) continue;
      const norm = normalizeVolcanoName(volcanoName);
      // Ключ дедупа — канонический slug там, где он есть: один вулкан не
      // должен приехать дважды под двумя написаниями.
      const key = norm?.slug ?? volcanoName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        volcanoName,
        nameSlug: norm?.slug ?? null,
        nameRu: norm?.ru ?? null,
        color,
        // Сводка даёт только текущий код: предыдущего, высоты вершины, высоты
        // пепла и текста в ней нет. Пустое поле честнее выдуманного.
        previousColor: null,
        summitElevationM: null,
        ashHeightM: null,
        area: null,
        noticeNumber: null,
        observedAt,
        summary: null,
      });
    }
  }

  return out;
}

/** «August 06, 2026, 23:53 UTC» → Date. null — не распознано. */
function parseReleaseDate(text: string): Date | null {
  const m = /([A-Z][a-z]+\s+\d{1,2},\s*\d{4}),?\s*(\d{2}):(\d{2})\s*UTC/.exec(text);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]}:${m[3]}:00 UTC`);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * HTML → текст со строками. `<br>` и закрытие блочных тегов дают перенос,
 * остальные теги снимаются, сущности разворачиваются.
 *
 * Тег ищется как «< до первого >» — без попыток догонять конкретные
 * закрывающие теги регуляркой. Разбор `</script >` и `</script foo>` шаблоном
 * — тупик, на который CodeQL уже указывал в этом же файле; здесь он и не
 * нужен: содержимое script/style не подходит под формат строки кодов и
 * отсеивается следующим шагом.
 */
function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ');
}
