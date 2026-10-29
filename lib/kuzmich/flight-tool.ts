/**
 * Кузьмич: «мой рейс задержан?» — по табло аэропорта Елизово (lib/flights/pkc-board).
 *
 * Только то, что на табло: время по расписанию, ожидаемое, статус словами
 * аэропорта. Причину задержки табло не называет — и Кузьмич её не называет.
 * Табло не прочиталось — так и сказано, с телефоном справочной: «задержек
 * нет» по непрочитанному табло было бы враньём (§4.0).
 */
import {
  loadPkcBoard, kamchatkaClock, lateWords, isDisrupted,
  PKC_BOARD_URL, PKC_INFO_PHONE,
  type BoardFlight, type BoardRead, type PkcBoard,
} from '@/lib/flights/pkc-board';

/** Кириллица, похожая на латиницу видом: «РТК-107» набрано вместо «PTK-107». */
const LOOKS_LATIN: Record<string, string> = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y' };
/** Кириллица по звучанию: «су 1731» — это SU 1731 (Аэрофлот). */
const SOUNDS_LATIN: Record<string, string> = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'ZH', З: 'Z', И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M',
  Н: 'N', О: 'O', П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'KH', Ц: 'TS', Ч: 'CH', Ш: 'SH', Ы: 'Y', Э: 'E', Ю: 'YU', Я: 'YA',
};

/** «su 1731», «SU-1731» → «SU1731». */
export function normalizeFlightNo(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Прочтения номера, набранного человеком: латиницей, кириллицей «на вид» и «на слух». */
export function flightKeys(s: string): string[] {
  const up = s.toUpperCase();
  const keys = [LOOKS_LATIN, SOUNDS_LATIN].map((map) => normalizeFlightNo(up.replace(/[А-ЯЁ]/g, (ch) => map[ch] ?? '')));
  return [...new Set(keys)].filter(Boolean);
}

function flightLine(f: BoardFlight): string {
  const sched = kamchatkaClock(f.scheduledAt);
  const way = f.direction === 'dep' ? `вылет в ${f.city}` : `прилёт из ${f.city}`;
  const parts = [`${f.flight} (${f.airline ?? 'авиакомпания не указана'}), ${way}, по расписанию ${sched.time} ${sched.date}`];
  if (f.status) parts.push(`статус: ${f.status}`);
  if (f.expectedAt) {
    const exp = kamchatkaClock(f.expectedAt);
    parts.push(`ожидается ${exp.time} ${exp.date}`);
  }
  if (f.lateMinutes !== null && f.lateMinutes >= 15) parts.push(`позже расписания на ${lateWords(f.lateMinutes)}`);
  if (f.note) parts.push(f.note);
  return `- ${parts.join('; ')}`;
}

function failedLine(label: string, read: BoardRead): string | null {
  return read.kind === 'failed' ? `Табло ${label} не прочиталось: ${read.reason}.` : null;
}

export function flightBoardText(board: PkcBoard, args: { flight?: string }): string {
  const fetched = kamchatkaClock(board.fetchedAt);
  const head = `Табло аэропорта Елизово (${PKC_BOARD_URL}), снято в ${fetched.time} по Камчатке. Время — камчатское.`;
  const failures = [failedLine('вылета', board.departures), failedLine('прилёта', board.arrivals)].filter(Boolean) as string[];
  const all = [board.departures, board.arrivals].flatMap((r) => (r.kind === 'ok' ? r.flights : []));

  if (failures.length === 2) {
    return [
      head,
      ...failures,
      `Это не значит, что задержек нет. Проверить можно на ${PKC_BOARD_URL} или в справочной аэропорта ${PKC_INFO_PHONE}, точное время — у авиакомпании.`,
    ].join('\n');
  }

  const wanted = args.flight ? flightKeys(args.flight) : [];
  if (wanted.length > 0) {
    const hits = all.filter((f) => wanted.includes(normalizeFlightNo(f.flight)));
    if (hits.length > 0) return [head, ...hits.map(flightLine), ...failures].join('\n');
    return [
      head,
      `Рейса ${args.flight} на табло сейчас нет. Табло показывает рейсы вчера–завтра, а уже вылетевшие аэропорт скрывает; проверь номер или спроси у авиакомпании.`,
      ...failures,
    ].join('\n');
  }

  const disrupted = all.filter(isDisrupted);
  const lines = disrupted.length > 0
    ? ['Задержки и отмены:', ...disrupted.map(flightLine)]
    : [`Задержек и отмен на прочитанном табло нет (рейсов на нём: ${all.length}).`];
  return [head, ...lines, ...failures, 'Причину задержки табло не называет.'].join('\n');
}

export async function flightBoardForKuzmich(args: { flight?: string }): Promise<string> {
  return flightBoardText(await loadPkcBoard(), args);
}
