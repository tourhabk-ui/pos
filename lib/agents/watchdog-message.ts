/**
 * Текст тревоги сторожа для Telegram — чистая сборка, без сети и базы.
 *
 * Аудит агентов 23.11: строки тревог уходили в Telegram с `parse_mode: HTML`
 * как есть. В них лежит чужой текст — сообщение ошибки базы, `error_msg`
 * упавшего крона, название внешней тревоги. Один знак «<» («Unexpected token
 * '<', "<!DOCTYPE"…») — и Telegram отвечает 400 на всё сообщение, вместе с
 * SOS-тревогой в нём. Отметка «отправлено» при отказе не ставится, поэтому
 * следующий прогон слал тот же текст и получал тот же отказ: сторож молчал,
 * пока причина не исчезнет сама.
 *
 * Здесь три защиты:
 *  - чужой текст экранируется, разметка остаётся только нашей;
 *  - сообщение укладывается в предел Telegram: не поместившееся названо числом,
 *    критические строки стоят первыми и отрезаются последними;
 *  - рядом собирается тот же текст без разметки — запасная попытка, если
 *    Telegram всё же отверг HTML (`tgSend(..., 'plain')`).
 */
import { escapeHtml } from '@/lib/text/escape-html';

/** Предел длины сообщения Telegram — 4096; запас на хвост и сущности. */
export const WATCHDOG_MESSAGE_LIMIT = 3900;

/** Причина отказа проверки — не длиннее этого: это текст ошибки, а не отчёт. */
const REASON_MAX = 160;
/** Сколько отказавших проверок называем поимённо. */
const FAILED_SHOWN = 6;

export interface WatchdogMessageInput {
  /** Тревоги к отправке в этом прогоне, в порядке проверок. */
  due: ReadonlyArray<{ critical: boolean; details: string }>;
  /** Сколько тревог не повторяем: о них писали в окне дебаунса. */
  suppressedCount: number;
  debounceHours: number;
  /** Проверки, не сумевшие выполниться. */
  failed: ReadonlyArray<{ check: string; reason: string }>;
  checksTotal: number;
  /** Адрес сайта без хвостовой косой черты. */
  adminUrl: string;
}

export interface WatchdogMessage {
  /** Текст с разметкой Telegram; чужой текст экранирован. */
  html: string;
  /** Тот же текст без разметки — для запасной попытки. */
  plain: string;
  /** Сколько тревог не поместилось в предел длины. */
  dropped: number;
}

interface Line { html: string; plain: string }

const line = (text: string): Line => ({ html: escapeHtml(text), plain: text });

/**
 * Собирает сообщение. Критические тревоги идут первыми: если всё не
 * помещается, отрезается хвост, и «КРИТ» в него попасть не должен.
 */
export function buildWatchdogMessage(input: WatchdogMessageInput): WatchdogMessage {
  const head: Line[] = [
    { html: '<b>Watchdog — требует внимания</b>', plain: 'Watchdog — требует внимания' },
    { html: '', plain: '' },
  ];

  const ordered = [...input.due].sort((a, b) => Number(b.critical) - Number(a.critical));
  const alertLines = ordered.map((a) => line(`${a.critical ? 'КРИТ:' : 'ВНИМАНИЕ:'} ${a.details}`));

  const tail: Line[] = [];
  if (input.suppressedCount > 0) {
    tail.push(line(`(и ещё ${input.suppressedCount} без изменений — писали в последние ${input.debounceHours} ч, не повторяю)`));
  }
  // «Не смог проверить» — отдельным блоком: у нарушения и у отказа проверки
  // разная природа и разное действие.
  if (input.failed.length > 0) {
    const title = `НЕ ПРОВЕРЕНО: ${input.failed.length} из ${input.checksTotal}`;
    tail.push({ html: '', plain: '' }, { html: `<b>${escapeHtml(title)}</b>`, plain: title });
    for (const f of input.failed.slice(0, FAILED_SHOWN)) {
      // Режем ДО экранирования: срез после него мог бы разрубить «&lt;».
      tail.push(line(`· ${f.check}: ${f.reason.slice(0, REASON_MAX)}`));
    }
    if (input.failed.length > FAILED_SHOWN) tail.push(line(`· и ещё ${input.failed.length - FAILED_SHOWN}`));
    tail.push(line('Это не «нарушений нет» — по этим проверкам ответа нет вовсе.'));
  }
  const panel = `${input.adminUrl}/hub/admin`;
  tail.push(
    { html: '', plain: '' },
    { html: `<a href="${escapeHtml(panel)}">Открыть панель</a>`, plain: `Панель: ${panel}` },
  );

  const size = (lines: Line[]) => lines.reduce((n, l) => n + l.html.length + 1, 0);
  const fixed = size(head) + size(tail);
  const kept: Line[] = [];
  let used = fixed;
  let dropped = 0;
  for (let i = 0; i < alertLines.length; i++) {
    const rest = alertLines.length - i;
    // Место под строку «не поместилось» держим, пока есть что отрезать.
    const note = rest > 1 ? 80 : 0;
    if (used + alertLines[i].html.length + 1 + note > WATCHDOG_MESSAGE_LIMIT) {
      dropped = rest;
      break;
    }
    kept.push(alertLines[i]);
    used += alertLines[i].html.length + 1;
  }
  // Одна тревога длиннее всего предела — режем её текст, а не теряем целиком.
  if (kept.length === 0 && alertLines.length > 0) {
    const room = Math.max(200, WATCHDOG_MESSAGE_LIMIT - fixed - 120);
    const first = ordered[0];
    kept.push(line(`${first.critical ? 'КРИТ:' : 'ВНИМАНИЕ:'} ${first.details}`.slice(0, room) + '…'));
    dropped = alertLines.length - 1;
  }
  const overflow = dropped > 0 ? [line(`… и ещё ${dropped} — не поместились в сообщение, полный список в панели`)] : [];

  const all = [...head, ...kept, ...overflow, ...tail];
  return {
    html: all.map((l) => l.html).join('\n'),
    plain: all.map((l) => l.plain).join('\n').slice(0, WATCHDOG_MESSAGE_LIMIT),
    dropped,
  };
}

/**
 * Отказ, при котором есть смысл повторить простым текстом: Telegram получил
 * запрос и отверг само сообщение (разметка, длина). Сеть, 403 «бот
 * заблокирован» и 429 повтором без разметки не лечатся.
 */
export function rejectedAsBadMessage(reason: string): boolean {
  return /Telegram ответил 400\b/.test(reason);
}
