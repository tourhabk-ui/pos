/**
 * CSV для выгрузок кабинета оператора — с защитой от формульной инъекции.
 *
 * Имя, телефон и пожелания туриста приходят в выгрузку из формы брони, то
 * есть их пишет посторонний человек. Значение, начинающееся с `=`, `+`, `-`,
 * `@` (а также с табуляции и возврата каретки), Excel и LibreOffice читают
 * как ФОРМУЛУ: `=HYPERLINK(...)` в поле «Клиент» превращался в ссылку в
 * таблице оператора, а `=cmd|...` — в DDE-вызов. До 25.09 `toCSV` экранировал
 * только разделители (аудит кабинета оператора, пакет «Г», п.6).
 *
 * Правило OWASP: такое значение предваряется апострофом — ячейка становится
 * текстом, и человек видит ровно то, что ввёл турист.
 *
 * Сторож: `tests/unit/operator-reports-csv.test.ts`.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

/** Одна ячейка: нейтрализовать формулу, затем экранировать разделители. */
export function csvCell(value: unknown): string {
  let v = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(v)) v = `'${v}`;
  return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Таблица с заголовками по-русски; BOM — чтобы Excel узнал UTF-8. */
export function toCSV(rows: Record<string, unknown>[], headers: Record<string, string>): string {
  const keys = Object.keys(headers);
  const head = keys.map((k) => csvCell(headers[k])).join(';');
  const body = rows.map((r) => keys.map((k) => csvCell(r[k])).join(';')).join('\n');
  return '﻿' + head + '\n' + body;
}
