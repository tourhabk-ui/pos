/**
 * Тексты карточки места, которые записала миграция, — для сторожа реестра
 * 1310 («всю не правду», слово владельца 22.10).
 *
 * Реестр 1310 — md5 текстов, положенных миграциями с названным источником.
 * Сторож пересчитывает их из самих файлов: выражение вынимается отсюда, а
 * значение складывает настоящий PostgreSQL (`SELECT md5(<выражение>)`), — так,
 * как его сложила база при выкате, со всеми `E'\n'`, `''` и `||`. Своя
 * склейка литералов в JS разошлась бы с базой на первом же экранировании.
 *
 * Разбор знает кавычки, `$$`-тела и оба вида комментариев: «;» или «--»
 * внутри текста описания не режут оператор.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { splitTop } from './migration-sql';

export const PLACE_TEXT_FIELDS = ['description', 'essence', 'access_info', 'best_season'] as const;
export type PlaceTextField = (typeof PLACE_TEXT_FIELDS)[number];

/** Запись поля оператором UPDATE places. */
export interface PlaceTextUpdate {
  migration: number;
  field: PlaceTextField;
  /**
   * literal — `поле = '…'`; coalesce — `поле = COALESCE(…, '…')` (пишет только
   * в пустое); append — `поле = поле || '…'` (дописывает к прежнему).
   */
  kind: 'literal' | 'coalesce' | 'append';
  /** Выражение-литерал: для append — только дописываемая часть. */
  expr: string;
  /** id мест из условия WHERE. */
  placeIds: string[];
}

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/** Номер миграции по имени файла; безномерные — null. */
export function migrationNumber(file: string): number | null {
  const m = /^(\d+)/.exec(file);
  return m ? Number(m[1]) : null;
}

/** Файлы миграции с этим номером (у некоторых номеров их несколько). */
export function migrationFiles(n: number): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && migrationNumber(f) === n);
}

export function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
}

/** Конец строкового литерала, начатого кавычкой в позиции i. */
function quoteEnd(sql: string, i: number): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "'") {
      if (sql[j + 1] === "'") { j += 2; continue; }
      return j;
    }
    j++;
  }
  return sql.length - 1;
}

/** Текст без комментариев; литералы и `$$`-тела — как есть. */
export function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      const j = quoteEnd(sql, i);
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (sql.startsWith('$$', i)) {
      const j = sql.indexOf('$$', i + 2);
      const end = j < 0 ? sql.length : j + 2;
      out += sql.slice(i, end);
      i = end;
    } else if (sql.startsWith('--', i)) {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? sql.length : j;
      out += ' ';
    } else if (sql.startsWith('/*', i)) {
      const j = sql.indexOf('*/', i + 2);
      i = j < 0 ? sql.length : j + 2;
      out += ' ';
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/** Операторы по «;» вне литералов и `$$`-тел. */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      const j = quoteEnd(sql, i);
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (sql.startsWith('$$', i)) {
      const j = sql.indexOf('$$', i + 2);
      const end = j < 0 ? sql.length : j + 2;
      cur += sql.slice(i, end);
      i = end;
    } else if (sql[i] === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
    } else {
      cur += sql[i];
      i++;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const isLiteral = (e: string) => /^E?'/.test(e);
const ID_IN_WHERE = /(?:\bid|ark_id)(?:::text)?\s*=\s*'([0-9a-f-]{36})'/g;

/**
 * Записи полей карточки операторами `UPDATE places … SET … WHERE`. NULL,
 * правки regexp_replace/replace и прочие нелитеральные выражения не
 * возвращаются: текста, который можно было бы сверить, они не пишут.
 */
export function placeTextUpdates(file: string): PlaceTextUpdate[] {
  const migration = migrationNumber(file);
  if (migration === null) return [];
  const out: PlaceTextUpdate[] = [];
  // UPDATE бывает и внутри WITH (запись журнала происхождения одним
  // оператором, 1034–1156): ищется каждое вхождение, а не начало оператора.
  const updates = statements(stripComments(readMigration(file))).flatMap((st) => {
    const starts = [...st.matchAll(/\bUPDATE\s+places\s+(?:p\s+)?SET\b/gi)].map((x) => x.index ?? 0);
    return starts.map((s, k) => st.slice(s, starts[k + 1] ?? st.length));
  });
  for (const st of updates) {
    const m = /^UPDATE\s+places\s+(?:p\s+)?SET\b([\s\S]*?)\bWHERE\b([\s\S]*)$/i.exec(st);
    if (!m) continue;
    const placeIds = [...m[2].matchAll(ID_IN_WHERE)].map((x) => x[1]);
    for (const part of splitTop(m[1])) {
      const pm = /^(\w+)\s*=\s*([\s\S]*)$/.exec(part.trim());
      if (!pm || !(PLACE_TEXT_FIELDS as readonly string[]).includes(pm[1])) continue;
      const field = pm[1] as PlaceTextField;
      const expr = pm[2].trim();
      if (isLiteral(expr)) {
        out.push({ migration, field, kind: 'literal', expr, placeIds });
        continue;
      }
      const co = /^COALESCE\(\s*(?:NULLIF\(\s*btrim\(\s*\w+\s*\)\s*,\s*''\s*\)|\w+)\s*,\s*([\s\S]*)\)$/i.exec(expr);
      if (co && isLiteral(co[1].trim())) {
        out.push({ migration, field, kind: 'coalesce', expr: co[1].trim(), placeIds });
        continue;
      }
      const ap = new RegExp(`^${field}\\s*\\|\\|\\s*([\\s\\S]*)$`).exec(expr);
      if (ap && isLiteral(ap[1].trim())) {
        out.push({ migration, field, kind: 'append', expr: ap[1].trim(), placeIds });
      }
    }
  }
  return out;
}

/** Операторы `INSERT INTO places` файла — целиком, для исполнения в транзакции. */
export function placeInserts(file: string): string[] {
  return statements(stripComments(readMigration(file))).filter((st) => /^INSERT\s+INTO\s+places\b/i.test(st));
}
