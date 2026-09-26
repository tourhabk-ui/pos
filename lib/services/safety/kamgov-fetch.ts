/**
 * kamgov.ru глазами раннера (#2064, 26.09).
 *
 * Сводки Минтура («маршрут закрыт», «посещение не рекомендуется») приходят
 * лентами kamgov.ru. С Timeweb сайт закрыт, поэтому их тянет раннер GitHub —
 * и 26.09 проба 605 показала, что раннеру он тоже отвечает 403 на все
 * адреса. Workflow в таком случае не присылал XML вовсе, а отчёт прогона
 * писал «источник ответил, постов нет»: отказ читался как тишина, и сводка не
 * доходила до статуса мест неделями, никого не разбудив.
 *
 * Здесь — один перевод «что ответили адреса» в результат разбора: ошибка с
 * кодами и rawItems 0 («сходили, ничего не получили», не «не запускали»).
 */
import type { ParseResult } from '@/lib/services/safety/seismic-parser';

export interface KamgovFetch { url: string; http: number; rss: boolean }

export function kamgovUnreachable(fetches: KamgovFetch[]): ParseResult {
  const codes = fetches
    .map((f) => {
      const path = f.url.replace(/^https?:\/\/(www\.)?kamgov\.ru/, '') || '/';
      const what = f.http === 0 ? 'нет ответа'
        : f.http >= 200 && f.http < 300 ? `HTTP ${f.http}, но не RSS` : `HTTP ${f.http}`;
      return `${path} ${what}`;
    })
    .join(', ');
  return {
    events: [], inserted: 0, skipped: 0, rawItems: 0,
    errors: [`kamgov.ru не отдал RSS раннеру: ${codes}`],
  };
}
