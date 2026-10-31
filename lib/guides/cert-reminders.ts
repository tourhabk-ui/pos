/**
 * Срок аттестата и переаттестации — строка в ежедневной сводке кабинета в
 * чате (слово владельца 30.10: «гид должен полностью управлять своей ролью
 * из MAX»). Новой рассылки нет: строка встаёт в сводку (lib/chat-cabinet/digest),
 * и в день, когда до срока 30, 7 или 1 день, сводка приходит и без входящих.
 *
 * Чтение аттестатов — одно с кабинетом на сайте (`GET /api/guide/certifications`).
 * Судим только записанными датами:
 *  - срок действия аттестата (`expiry_date`) — у неотклонённых аттестатов;
 *    без срока строки нет (не знаем — не пугаем);
 *  - переаттестация — по правилу lib/guides/reattestation (`needed` и дни до
 *    REATTESTATION_DEADLINE). Срок прошёл — строки нет: напоминание «за день
 *    до» после срока было бы неправдой.
 * Персональных данных в строке нет: вид аттестата и дата.
 */

import { query } from '@/lib/database';
import { GUIDE_CERT_COLUMNS, toGuideCert, type GuideCertRow } from '@/lib/guides/certification-input';
import { REATTESTATION_DEADLINE, reattestationStatus } from '@/lib/guides/reattestation';
import { ruShort } from '@/lib/analytics/kamchatka-day';
import { escapeHtml } from '@/lib/text/escape-html';

export type GuideCert = ReturnType<typeof toGuideCert>;

/** Аттестаты гида — то же чтение, что кабинет на сайте. Отказ базы — исключение. */
export async function listGuideCertifications(guideId: string): Promise<GuideCert[]> {
  const { rows } = await query<GuideCertRow>(
    `SELECT ${GUIDE_CERT_COLUMNS}
     FROM guide_certifications
     WHERE guide_id = $1
     ORDER BY issue_date DESC NULLS LAST, created_at DESC`,
    [guideId],
  );
  return rows.map(toGuideCert);
}

/** За сколько дней до срока строка встаёт в сводку. */
export const CERT_REMIND_DAYS: readonly number[] = [30, 7, 1];

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

function daysWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'день';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дня';
  return 'дней';
}

function whenWords(days: number, date: string): string {
  return days === 1 ? `завтра, ${ruShort(date)}` : `через ${days} ${daysWord(days)}, ${ruShort(date)}`;
}

/**
 * Строки сводки на сегодня (камчатская дата `today`). Пусто — сегодня
 * напоминать не о чем. Текст — HTML мессенджера, введённое экранировано.
 */
export function certReminderLines(certs: readonly GuideCert[], today: string): string[] {
  const lines: string[] = [];
  for (const c of certs) {
    if (c.review === 'rejected' || !c.expiryDate) continue;
    const left = daysBetween(today, c.expiryDate);
    if (!CERT_REMIND_DAYS.includes(left)) continue;
    lines.push(`Аттестат «${escapeHtml(c.name)}» истекает ${whenWords(left, c.expiryDate)}. Новый — в кабинете на сайте, раздел «Аттестаты».`);
  }
  const live = certs.filter((c) => c.review !== 'rejected').map((c) => ({ issue_date: c.issueDate }));
  if (reattestationStatus(live) === 'needed') {
    const left = daysBetween(today, REATTESTATION_DEADLINE);
    if (CERT_REMIND_DAYS.includes(left)) {
      lines.push(`Переаттестация инструктора-проводника — срок ${whenWords(left, REATTESTATION_DEADLINE)}. Аттестата новее 01.07.2024 в кабинете нет.`);
    }
  }
  return lines;
}
