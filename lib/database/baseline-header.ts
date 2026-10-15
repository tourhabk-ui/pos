/**
 * lib/database/baseline-header.ts
 *
 * Шапка baseline-схемы прод-БД — ОДИН разбор на всех читателей.
 *
 * ── Повод (аудит 15.10, находка P2-10, пункт 1.8) ─────────────────────────
 *
 * Граница «что уже внутри снимка, а что надо доиграть миграциями» жила
 * литералом `FIRST_AFTER_BASELINE = 863` в четырнадцати интеграционных
 * тестах и в инструкции `scripts/gen-db-schema.ts`. Число верное — но верно
 * оно ровно до первого пересъёма baseline: свежий снимок сдвинет границу, а
 * четырнадцать копий останутся на 863 и будут доигрывать поверх снимка
 * миграции, которые в нём уже есть. Правило, записанное четырнадцать раз, —
 * это четырнадцать правил (тот же довод, что у migration-order).
 *
 * Теперь граница — строка шапки самого baseline, и пишет её тот же, кто
 * пишет снимок: `scripts/assemble-db-baseline.py`. Здесь — её разбор, и
 * версия сервера, с которого снимок снят (по ней сверяется образ PostgreSQL
 * в CI).
 *
 * ── Третий исход ──────────────────────────────────────────────────────────
 *
 * Строки нет или она не разбирается — `null`, а не «863 по умолчанию» и не
 * «0». Вызывающий обязан сказать вслух, что граница не установлена (§4.0):
 * шаблон схемы, построенный по выдуманной границе, тише и опаснее, чем
 * упавший.
 */
import { migrationNumber } from './migration-order';

/** Метка строки границы. Её же пишет сборщик baseline — строка в строку. */
export const BASELINE_LAST_MIGRATION_LABEL = '-- Последняя миграция в снимке:';

/** Метка строки сервера (пишет сборщик из `SELECT version()` прода). */
export const BASELINE_SERVER_LABEL = '-- Сервер:';

export interface BaselineHeader {
  /** Имя последней миграции, действие которой уже внутри снимка. */
  lastMigration: string | null;
  /** Первый номер ПОСЛЕ снимка: всё с номером не меньше — доигрывается. */
  firstAfter: number | null;
  /** Строка версии сервера целиком, как её отдал прод. */
  server: string | null;
  /** Мажорная версия сервера прода (18 из «PostgreSQL 18.1 ...»). */
  serverMajor: number | null;
}

/**
 * Строки шапки: ведущий блок комментариев до первой пустой или
 * некомментарной строки. Ниже шапки метки не ищутся — в теле baseline их
 * быть не должно, а совпадение там было бы случайностью, а не фактом.
 */
function headerLines(sql: string): string[] {
  const out: string[] = [];
  for (const raw of sql.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('--')) break;
    out.push(line);
  }
  return out;
}

function valueAfter(lines: string[], label: string): string | null {
  const hit = lines.find((l) => l.startsWith(label));
  if (!hit) return null;
  const v = hit.slice(label.length).trim();
  return v.length > 0 ? v : null;
}

/** Мажор из строки `version()`: «PostgreSQL 18.1 (Ubuntu ...)» → 18. */
export function serverMajorOf(server: string | null): number | null {
  if (!server) return null;
  const m = /^PostgreSQL (\d+)(?:\.\d+)?\b/.exec(server);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function parseBaselineHeader(sql: string): BaselineHeader {
  const lines = headerLines(sql);

  const last = valueAfter(lines, BASELINE_LAST_MIGRATION_LABEL);
  // Имя миграции — одно слово с номером и `.sql`. «862» или «862_x» без
  // расширения — не имя файла, и выдавать их за границу нельзя.
  const lastMigration = last && /^\S+\.sql$/.test(last) ? last : null;
  const n = lastMigration ? migrationNumber(lastMigration) : null;

  const server = valueAfter(lines, BASELINE_SERVER_LABEL);
  return {
    lastMigration: n === null ? null : lastMigration,
    firstAfter: n === null ? null : n + 1,
    server,
    serverMajor: serverMajorOf(server),
  };
}
