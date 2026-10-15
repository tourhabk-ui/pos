'use client';

/**
 * Отчёт о виджете за 30 дней — один компонент на кабинет оператора и
 * карточку в админке (аудит 15.10, находка WID-screens, W7).
 *
 * Строки и их слова — lib/embed/widget-report-view (границы как в переписи:
 * загрузки — «до N», открытия — «не меньше N»). Часть, которая не
 * прочиталась, — «не загрузилось» у своей строки, а не ноль (§4.0). Стоит ли
 * код на сайте — только по пробе этого запроса; без неё «не проверено».
 *
 * Только агрегаты: ни имён, ни телефонов посетителей в отчёте нет.
 */
import { AlertTriangle, Globe, Search, Loader2 } from 'lucide-react';
import type { PartnerWidgetReport } from '@/lib/analytics/widget-census';
import {
  NOT_LOADED, NOT_CHECKED, widgetReportLines, widgetHostLines, widgetSitePresence,
} from '@/lib/embed/widget-report-view';

export function WidgetUsageReport({
  report,
  showFailedMeasures = false,
  onProbe,
  probing = false,
}: {
  report: PartnerWidgetReport;
  /** Админке — имена несостоявшихся частей с SQLSTATE; оператору хватает строк. */
  showFailedMeasures?: boolean;
  /** Есть — рядом с «стоит ли код» кнопка свежей пробы (только админка). */
  onProbe?: () => void;
  probing?: boolean;
}) {
  const lines = widgetReportLines(report);
  const hosts = widgetHostLines(report);
  const presence = widgetSitePresence(report);

  return (
    <div className="space-y-4">
      <dl className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-lg" aria-label="Отчёт за 30 дней">
        {lines.map((l) => (
          <div key={l.key} className="px-3 py-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5" data-line={l.key}>
            <dt className="text-sm text-[var(--text-primary)]">{l.label}</dt>
            <dd className={`text-sm text-right tabular-nums ${l.value === null ? 'text-[var(--warning)]' : 'text-[var(--text-primary)] font-medium'}`}>
              {l.value ?? (
                <span className="inline-flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden /> {NOT_LOADED}
                </span>
              )}
            </dd>
            <dd className="col-span-2 text-xs text-[var(--text-muted)]">{l.hint}</dd>
          </div>
        ))}
      </dl>

      <div>
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)] mb-1">
          <Globe className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden />
          Откуда загружали и открывали
        </div>
        {hosts === null ? (
          <p className="text-xs text-[var(--warning)]">{NOT_LOADED}</p>
        ) : hosts.length === 0 ? (
          <p className="text-xs text-[var(--text-secondary)]">За 30 дней ни одной загрузки кнопки заявки и ни одного открытия окна.</p>
        ) : (
          <ul className="text-xs text-[var(--text-secondary)] space-y-0.5" aria-label="По адресам страниц">
            {hosts.map((h, i) => (
              <li key={`${h.host}-${h.widget}-${i}`}>
                <span className="text-[var(--text-primary)]">{h.host}</span> — {h.check}, {h.widget}:
                {h.served !== null && <> загрузок {h.served},</>} открытий {h.opened}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-[var(--text-muted)] mt-1">
          Адрес страницы присылает браузер посетителя, и подделать его может кто угодно: это сигнал, а не доказательство.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm text-[var(--text-primary)]">
            Стоит ли код на сайте:{' '}
            <span className={presence.summary === NOT_CHECKED ? 'text-[var(--text-secondary)]' : 'font-medium'} data-presence>
              {presence.summary}
            </span>
          </div>
          {onProbe && (
            <button
              type="button"
              onClick={onProbe}
              disabled={probing}
              className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--accent)] hover:opacity-75 transition-opacity disabled:opacity-50 shrink-0"
            >
              {probing ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <Search className="w-3 h-3" aria-hidden />}
              Проверить главные сейчас
            </button>
          )}
        </div>
        {presence.domains.length > 0 && (
          <ul className="text-xs text-[var(--text-secondary)] mt-1 space-y-0.5">
            {presence.domains.map((d) => (
              <li key={d.domain}><span className="text-[var(--text-primary)]">{d.domain}</span> — {d.text}</li>
            ))}
          </ul>
        )}
        {presence.summary === NOT_CHECKED && (
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Сайт этот экран не опрашивает. Загрузки и открытия выше — косвенный признак, а не проверка.
          </p>
        )}
      </div>

      {report.failed_measures.length > 0 && (
        <p className="text-xs text-[var(--warning)]">
          Часть отчёта не загрузилась — у этих строк написано «{NOT_LOADED}», это не ноль.
          {showFailedMeasures && (
            <> Не прочитано: {report.failed_measures.map((f) => `${f.measure} (${f.sqlstate})`).join(', ')}.</>
          )}
        </p>
      )}
    </div>
  );
}
