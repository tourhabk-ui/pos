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
