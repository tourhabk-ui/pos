/**
 * Интервал не собирается склейкой строки.
 *
 * ── Почему именно интервал ─────────────────────────────────────────────────
 *
 * Правило платформы «SQL — только параметризованный» знают все, и обходят его
 * почти всегда в одном месте: у интервала. `WHERE created_at >= NOW() -
 * INTERVAL '${period}'` выглядит вынужденным — кажется, что `$1` в литерал
 * интервала не поставишь.
 *
 * Поставишь. Postgres умеет и `$1::interval` для свободного текста («7 days»),
 * и `INTERVAL '1 day' * $1` для числа. То есть обход правила был не нужен ни
 * разу — он просто выглядел необходимым.
 *
 * Находка эволюции 19.08 (issue #1293) назвала два таких места в
 * `lib/auth/tourist-helpers.ts`. Их оказалось шесть, в четырёх файлах:
 * платежи трансферов, подбор водителей (два запроса) и блокировка мест.
 * Отсюда и сторож: единичное исправление здесь бессмысленно, потому что
 * следующий человек напишет то же самое с тем же ощущением вынужденности.
 *
 * ── Что именно ищется ──────────────────────────────────────────────────────
 *
 * Литерал интервала, внутрь которого подставляется значение. Умножение
 * интервала на параметр (`INTERVAL '1 day' * $2`) — законная форма, и
 * подстановки в нём нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Все исходники платформы — кроме тестов: в них SQL бывает нарочно плохим. */
function sources(): string[] {
  const out = execSync(
    "git ls-files 'lib/**/*.ts' 'app/**/*.ts' 'app/**/*.tsx' 'scripts/**/*.ts'",
    { encoding: 'utf-8', cwd: process.cwd() },
  );
  return out.split('\n').filter(Boolean).filter((f) => !f.includes('/tests/'));
}

/** `INTERVAL '...${...}...'` — подстановка внутрь литерала интервала. */
const INTERPOLATED_INTERVAL = /INTERVAL\s*'[^']*\$\{/i;

describe('интервал в SQL приходит параметром', () => {
  const files = sources();

  it('исходники найдены', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('ни один литерал интервала не собирается склейкой', () => {
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
        if (INTERPOLATED_INTERVAL.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      bad,
      'интервал параметризуется: $1::interval для текста, INTERVAL \'1 day\' * $1 для числа',
    ).toEqual([]);
  });

  it('сторож ловит именно ту форму, что была в коде', () => {
    // Обе строки — как они выглядели до починки.
    expect(INTERPOLATED_INTERVAL.test("WHERE created_at >= NOW() - INTERVAL '${period}'")).toBe(true);
    expect(INTERPOLATED_INTERVAL.test("expiry_date <= CURRENT_DATE + INTERVAL '${days} days'")).toBe(true);
    // А законные формы не трогает.
    expect(INTERPOLATED_INTERVAL.test("CURRENT_DATE + (INTERVAL '1 day' * $2)")).toBe(false);
    expect(INTERPOLATED_INTERVAL.test('NOW() - $1::interval')).toBe(false);
  });
});
