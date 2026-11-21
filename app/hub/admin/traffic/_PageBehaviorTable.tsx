'use client';

import React from 'react';
import { internalHref } from '@/lib/analytics/traffic-links';
import { dwellExitShare, type PageDwellCounts } from '@/lib/analytics/page-dwell';

export interface PageBehaviorRow extends PageDwellCounts {
  path: string;
  views: number;
  medianMs: number | null;
  exits: number;
}

/** Время на странице: секунды до минуты, дальше м:сс. Прочерк — если не досказано. */
export function fmtDwell(ms: number | null): string {
  if (ms == null) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} с`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * Путь из журнала — ссылкой на саму страницу, в новой вкладке: сводка остаётся
 * открытой (владелец 25.09). Не путь сайта — текстом (lib/analytics/traffic-links).
 */
export function PathLink({ path, className }: { path: string; className: string }) {
  const href = internalHref(path);
  if (!href) return <span className={className} title={path}>{path}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      title={`Открыть ${path}`}
      className={`${className} hover:text-[var(--ocean)] hover:underline underline-offset-2`}
    >
      {path}
    </a>
  );
}

/**
 * Подпись к колонкам со временем — одна на обе таблицы (21.11).
 */
export const DWELL_COLUMNS_NOTE =
  'Со временем — просмотры, для которых браузер дослал видимое время: так делает живой браузер при переходе, ' +
  'скрытии вкладки или уходе. Автоматический браузер, закрывший вкладку, его не досылает. Это признак, а не ' +
  'доказательство человека: телефон, выгрузивший вкладку, время тоже не дошлёт. Время в колонке «Время» — ' +
  'медиана только по этим просмотрам.';

/**
 * Таблица поведения страниц: общий счёт и рядом — по просмотрам с записанным
 * временем. Уход «среди них» без таких просмотров — прочерк, не «0%».
 */
export function PageBehaviorTable({ rows, warnExitAt }: { rows: PageBehaviorRow[]; warnExitAt: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            <th className="text-left font-medium pb-2">Страница</th>
            <th className="text-right font-medium pb-2">Просмотры</th>
            <th className="text-right font-medium pb-2">Уход</th>
            <th className="text-right font-medium pb-2 pl-3">Со временем</th>
            <th className="text-right font-medium pb-2">Время</th>
            <th className="text-right font-medium pb-2">Уход среди них</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => {
            const share = dwellExitShare(p);
            return (
              <tr key={p.path} className="border-t border-[var(--border)]">
                <td className="py-1.5 pr-3 max-w-0 truncate">
                  <PathLink path={p.path} className="font-mono text-[var(--text-secondary)]" />
                </td>
                <td className="py-1.5 text-right font-mono text-[var(--text-primary)] tabular-nums">{p.views}</td>
                <td className="py-1.5 text-right font-mono tabular-nums" style={{ color: pct(p.exits, p.views) >= warnExitAt ? 'var(--warning)' : 'var(--text-primary)' }}>
                  {pct(p.exits, p.views)}%
                </td>
                <td className="py-1.5 pl-3 text-right font-mono text-[var(--text-primary)] tabular-nums">{p.withDwell}</td>
                <td className="py-1.5 text-right font-mono text-[var(--text-primary)] tabular-nums">{fmtDwell(p.medianMs)}</td>
                <td className="py-1.5 text-right font-mono text-[var(--text-primary)] tabular-nums">
                  {share == null ? '—' : `${share}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
