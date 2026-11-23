/**
 * Сводка ответа крона для лога GitHub Actions — вместо тела целиком.
 *
 * Репозиторий публичный, лог Actions читает любой. Перепись 23.11: 96 workflow
 * печатали тело ответа прода (`cat /tmp/out.json`). В большинстве тел — одни
 * счётчики, но не во всех: имена операторов «без броней семь дней» и номера
 * броней (rescue), номера заявок с текстом ошибки (leads-process), текст задач
 * ядра (kernel-worker). Тело сторожа с координатами SOS убрано раньше
 * (scripts/watchdog-step.mjs).
 *
 * Правило сводки — «числа и состояния, без строк данных»:
 *   - число, true/false, null — как есть; число от ста миллионов — только
 *     его длина (так выглядят номера чатов и телефоны);
 *   - строка — только короткое слово-состояние (латиница, цифры, `_.:-/`,
 *     без пробелов: `lease_held`, `ok`, отметка времени); любая другая —
 *     «строка, N зн.»: свободный текст и кириллица в лог не идут;
 *   - массив — только длина: строки данных (имена, номера, тексты) живут в
 *     массивах;
 *   - вложенный объект — те же правила, не глубже двух уровней;
 *   - поле с именем про человека или место человека (name, phone, email,
 *     lat, lng, text, message…) — «скрыто», каким бы ни было значение.
 *
 * При отказе (не 200) нужен повод чинить: печатается поле `error`, очищенное
 * от значений — почта, длинные цифры и содержимое кавычек заменены.
 *
 * Запуск: node scripts/cron-body-summary.mjs <файл> [http-код]
 * Всегда выходит с кодом 0: исход шага решает сам шаг по коду HTTP.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_LINES = 60;
const MAX_DEPTH = 2;
const STATE_WORD = /^[A-Za-z0-9_.:\-/]{1,40}$/;
/** Семь цифр подряд — номер (телефон, чат), а не состояние и не отметка времени. */
const LONG_DIGITS = /\d{7,}/;
/** Число такой величины — номер чата или телефон, а не счётчик. */
const BIG_NUMBER = 1e8;
/** Имя поля говорит о человеке или его месте — значение не печатается. */
const PERSON_KEY = /(^|_)(lat|lng|lon|latitude|longitude|coords?|coordinates|phone|tel|email|mail|name|fio|chat|user|text|message|comment|address|passport|ip|token|secret|key)(_|$|s$)/i;

/** `telegramChatId` и `telegram_chat_id` — одно имя: судим по словам. */
function aboutPerson(key) {
  return PERSON_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

function scalar(key, value) {
  if (value !== null && typeof value === 'object') return null;
  if (aboutPerson(key)) return 'скрыто';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    return Math.abs(value) >= BIG_NUMBER ? `число, ${String(Math.trunc(Math.abs(value))).length} зн.` : String(value);
  }
  if (typeof value === 'string') {
    return STATE_WORD.test(value) && !LONG_DIGITS.test(value) ? value : `строка, ${value.length} зн.`;
  }
  return null;
}

/** Строки сводки по разобранному телу. */
export function summarizeBody(body) {
  if (body === null || typeof body !== 'object') {
    return [`ответ не объект: ${Array.isArray(body) ? 'массив' : typeof body}`];
  }
  if (Array.isArray(body)) return [`массив из ${body.length}`];
  const lines = [];
  const walk = (obj, prefix, depth) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const s = scalar(key, value);
      if (s !== null) { lines.push(`${path}: ${s}`); continue; }
      if (Array.isArray(value)) { lines.push(`${path}: [${value.length}]`); continue; }
      if (aboutPerson(key)) { lines.push(`${path}: скрыто`); continue; }
      const keys = Object.keys(value);
      if (depth >= MAX_DEPTH) { lines.push(`${path}: {ключей: ${keys.length}}`); continue; }
      walk(value, path, depth + 1);
    }
  };
  walk(body, '', 1);
  if (lines.length > MAX_LINES) {
    return [...lines.slice(0, MAX_LINES), `… и ещё ${lines.length - MAX_LINES} полей`];
  }
  return lines.length > 0 ? lines : ['пустой объект'];
}

/** Текст ошибки без значений: почта, длинные цифры и содержимое кавычек. */
export function scrubError(text) {
  return String(text)
    .replace(/[^\s"'<>()]+@[^\s"'<>()]+/g, '[почта]')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/«[^»]*»/g, '«…»')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[цифры]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Строки для лога: сводка тела и, при отказе, очищенная ошибка. */
export function bodyLogLines(bodyText, http) {
  const raw = String(bodyText ?? '');
  if (raw.trim() === '') return ['тело пустое'];
  let body;
  try { body = JSON.parse(raw); } catch { return [`тело не JSON, ${raw.length} зн. — не печатается`]; }
  const lines = summarizeBody(body);
  const failed = typeof http === 'number' && http !== 200;
  const error = body && typeof body === 'object' && !Array.isArray(body) ? body.error : undefined;
  if (failed && typeof error === 'string' && error.trim() !== '') {
    lines.push(`ошибка (без значений): ${scrubError(error)}`);
  }
  return lines;
}

function main() {
  const file = process.argv[2];
  if (!file) { console.log('сводка: файл ответа не назван'); return; }
  const httpArg = Number(process.argv[3]);
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { console.log('сводка: файла ответа нет'); return; }
  for (const line of bodyLogLines(text, Number.isFinite(httpArg) && httpArg > 0 ? httpArg : undefined)) console.log(line);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
