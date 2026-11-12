#!/usr/bin/env node
/**
 * Копия кода для ревью безопасности — без телефонов и почт.
 *
 * Ревьюер (.github/workflows/security-review.yml) — зарубежная модель
 * (deepseek-flash). Он читает не один дифф: Read, Grep и git show видят весь
 * репозиторий, а git log — почты авторов коммитов. В коде лежат телефоны
 * живых людей (контактные лица партнёров, бывший сотрудник партнёра), и
 * правило 2 ревьюера (`.github/security-review-rules.md`) само называет
 * такое трансграничной передачей ПД (152-ФЗ). Находка ревью PR #3298, 12.11.
 *
 * Почему не `redactPII` (lib/security/pii-redact.ts): она настроена на речь
 * человека и режет любое слово из 10–15 цифр — в коде это метки времени
 * (1730000000000), предел int (2147483647), номера заявок. Ревьюер увидел бы
 * «[телефон]» вместо константы, от которой зависит проверка. Здесь телефон —
 * только по форме номера: «+7»/«8» и 10 цифр группами, «+» и 10–15 цифр
 * международного номера, «79…»/«89…» одним словом из 11 цифр.
 *
 * Почты — все, кроме доменов, которые не принадлежат человеку: свой
 * (vedarai.ru и прежний tourhab.ru — ревьюеру нужно видеть, кому уходит
 * письмо платформы) и зарезервированные для примеров (example.*, .invalid,
 * .test, .local, localhost).
 *
 * Строки не сдвигаются: замена не съедает перевод строки, и номер строки в
 * находке ревью совпадает с PR. Бинарные файлы и файлы не в UTF-8 не
 * трогаются, символические ссылки не разыменовываются.
 *
 * Вызов: node review-pii-scrub.mjs <каталог или файл>... — печатает только
 * счётчики, ни одного найденного значения (лог прогона публичный).
 * Сторож: tests/unit/review-pii-scrub.test.ts.
 */
import { readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export const PHONE_MARK = '[телефон]';
export const EMAIL_MARK = '[email]';

// Разделители внутри номера — только в строке: перевод строки номер не склеивает.
const SEP = '[ \\t\\u00a0\\-–—]*';
const RU_PHONE = new RegExp(
  `(?<![\\w+.-])(?:\\+7|8)${SEP}\\(?${SEP}\\d{3}${SEP}\\)?${SEP}\\d{3}${SEP}\\d{2}${SEP}\\d{2}(?![\\w.])`,
  'g',
);
// «79147822222», «89001234567» — одним словом.
const RU_PHONE_WORD = /(?<![\w.+])[78]9\d{9}(?![\w.])/g;
// Международный: «+», затем 10–15 цифр с разделителями.
const INTL_PHONE = /(?<![\w+])\+\d[\d \t\u00a0()\-–]{8,22}\d(?![\w.])/g;
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w-])/g;

const KEEP_DOMAINS = ['vedarai.ru', 'tourhab.ru', 'example.com', 'example.org', 'example.net', 'example.ru', 'localhost'];
const KEEP_TLDS = ['invalid', 'test', 'example', 'localhost', 'local'];

function keptDomain(domain) {
  const d = domain.toLowerCase();
  if (KEEP_DOMAINS.some((k) => d === k || d.endsWith(`.${k}`))) return true;
  return KEEP_TLDS.includes(d.slice(d.lastIndexOf('.') + 1));
}

const digits = (s) => s.replace(/\D/g, '').length;

/** Чистит текст кода. Возвращает текст и сколько чего заменено. */
export function scrubCode(text) {
  let phones = 0;
  let emails = 0;
  let out = text.replace(EMAIL, (m, domain) => {
    if (keptDomain(domain)) return m;
    emails += 1;
    return EMAIL_MARK;
  });
  out = out.replace(RU_PHONE, () => {
    phones += 1;
    return PHONE_MARK;
  });
  out = out.replace(RU_PHONE_WORD, () => {
    phones += 1;
    return PHONE_MARK;
  });
  out = out.replace(INTL_PHONE, (m) => {
    const n = digits(m);
    if (n < 10 || n > 15) return m;
    phones += 1;
    return PHONE_MARK;
  });
  return { text: out, phones, emails };
}

/** Бинарный или не UTF-8 — не трогаем. */
function asText(buf) {
  if (buf.subarray(0, 8000).includes(0)) return null;
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;
}

/** Чистит файлы на месте, обходя каталоги (кроме .git). */
export function scrubPaths(paths) {
  const total = { files: 0, changed: 0, phones: 0, emails: 0, skipped: 0 };
  const visit = (p) => {
    if (basename(p) === '.git') return;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) visit(join(p, name));
      return;
    }
    if (!st.isFile()) return;
    total.files += 1;
    const buf = readFileSync(p);
    const text = asText(buf);
    if (text === null) {
      total.skipped += 1;
      return;
    }
    const r = scrubCode(text);
    if (r.text === text) return;
    writeFileSync(p, r.text);
    total.changed += 1;
    total.phones += r.phones;
    total.emails += r.emails;
  };
  for (const p of paths) visit(p);
  return total;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('Нужен хотя бы один каталог или файл.');
    process.exit(2);
  }
  try {
    const t = scrubPaths(paths);
    process.stdout.write(
      `Копия для ревью: файлов ${t.files}, изменено ${t.changed}, телефонов ${t.phones}, почт ${t.emails}, не текст ${t.skipped}.\n`,
    );
  } catch (e) {
    console.error(`Чистка копии не удалась: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
