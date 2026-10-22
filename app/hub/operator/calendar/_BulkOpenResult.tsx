'use client';

/**
 * Итог массового открытия дат («Свободные даты» календаря кабинета).
 *
 * Отдельным компонентом, чтобы итог судился рендером (правило 13.10): что
 * оператор видит после «Открыть даты».
 *
 * Строки по исходам, а не одно «Открыто N»:
 *   - зелёная — открыто (включая открытые снова), обновлено, пропущено; только
 *     когда есть что назвать успехом — при всех датах в отказе она сказала бы
 *     «Открыто 0» цветом удачи;
 *   - открыто СНОВА — поимённо и с причиной закрытия. Кабинет открывает и
 *     закрытые оператором даты (например, «Шторм»), причина при этом
 *     снимается; без отдельной строки такая дата растворялась в «Открыто N», и
 *     открытая обратно после закрытия по погоде дата ничем не выделялась
 *     (ревью 22.10);
 *   - не открыто — записано больше мест, чем в форме, с числом записанных.
 */

import { CheckCircle, AlertTriangle } from 'lucide-react';
import { formatDateOnly } from '@/lib/dates/date-only';

export interface BulkResult {
  /** Открыто, включая открытые снова. */
  opened: number;
  /** Были открыты — места переписаны (без «Не перезаписывать»). */
  updated: number;
  /** Были открыты — не тронуты («Не перезаписывать»). */
  skipped: number;
  /** Открыты снова: были закрыты (с причиной оператора) или сняты. */
  reopenedDates?: Array<{ date: string; reason: string | null }>;
  /** Не открыты: записано больше мест, чем в форме (места ниже записанных не ставятся). */
  refused: Array<{ date: string; taken: number }>;
  total: number;
}

const LIST_LIMIT = 10;
const shortDay = (date: string) => formatDateOnly(date, { day: 'numeric', month: 'short' });

export function BulkOpenResult({ result }: { result: BulkResult }) {
  const refused = result.refused ?? [];
  const reopened = result.reopenedDates ?? [];
  const anySuccess = result.opened + (result.updated ?? 0) + result.skipped > 0;
  return (
    <>
      {(anySuccess || refused.length === 0) && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{ background: 'rgba(63,185,80,0.10)', color: 'var(--success)' }}>
          <CheckCircle className="w-3.5 h-3.5 shrink-0" />
          <div className="text-xs">
            <span className="font-bold">Открыто {result.opened} дат</span>
            {(result.updated ?? 0) > 0 && ` · обновлено ${result.updated}`}
            {result.skipped > 0 && ` · пропущено ${result.skipped}`}
            {' '}из {result.total} в диапазоне
          </div>
        </div>
      )}
      {reopened.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border-l-4"
          style={{ borderLeftColor: 'var(--warning)', color: 'var(--warning)' }}>
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="text-xs">
            <span className="font-bold">Из них открыто снова {reopened.length} — были закрыты или сняты</span>
            <span style={{ color: 'var(--text-secondary)' }}>
              {': '}
              {reopened.slice(0, LIST_LIMIT)
                .map(r => (r.reason ? `${shortDay(r.date)} («${r.reason}»)` : shortDay(r.date)))
                .join(', ')}
              {reopened.length > LIST_LIMIT && ` и ещё ${reopened.length - LIST_LIMIT}`}
              {'. Причина закрытия снята; если дату закрывали не зря — закройте её снова в календаре.'}
            </span>
          </div>
        </div>
      )}
      {refused.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border-l-4"
          style={{ borderLeftColor: 'var(--warning)', color: 'var(--warning)' }}>
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="text-xs">
            <span className="font-bold">Не открыто {refused.length}: уже записано больше мест</span>
            <span style={{ color: 'var(--text-secondary)' }}>
              {' — '}
              {refused.slice(0, LIST_LIMIT)
                .map(r => `${shortDay(r.date)} (записано ${r.taken})`)
                .join(', ')}
              {refused.length > LIST_LIMIT && ` и ещё ${refused.length - LIST_LIMIT}`}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
