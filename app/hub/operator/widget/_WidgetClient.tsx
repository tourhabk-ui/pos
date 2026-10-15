'use client';

/**
 * Экран «Виджет на ваш сайт» в кабинете оператора (аудит 15.10, находка
 * WID-screens, W7; решение главной сессии по карт-бланшу владельца 15.10).
 *
 * До этого партнёр не видел ни кода вставки, ни результата: код передавался
 * через владельца и посредника, отчёт не показывался нигде, а готовый
 * /api/hub/operator/leads/report так и остался без экрана.
 *
 * Здесь:
 *  - включён ли виджет (включает администратор Ведара — так и сказано);
 *  - оба кода вставки — чат и кнопка заявки (components/widget/WidgetEmbedCodes);
 *  - домены сайта — только чтение: список ведёт администратор, и он ничего
 *    не запирает, по нему лишь видно, откуда пришёл посетитель;
 *  - отчёт за 30 дней из той же логики, что перепись (GET
 *    /api/hub/operator/widget → widgetReportForPartner), с границами словами;
 *  - стоит ли код на сайте — «не проверено»: этот экран сайт не опрашивает.
 *
 * Три исхода запроса (§4.0): отчёт; отказ части — «не загрузилось» у строки;
 * отказ целиком — экран «не загрузилось» с причиной и «Повторить», а не
 * пустой отчёт.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Code2, Globe, BarChart3, Power } from 'lucide-react';
import { LoadingSpinner, EmptyState } from '@/components/admin/shared';
import { WidgetEmbedCodes } from '@/components/widget/WidgetEmbedCodes';
import { WidgetUsageReport } from '@/components/widget/WidgetUsageReport';
import { parsePartnerWidgetReport } from '@/lib/embed/widget-report-view';
import { SUPPORT } from '@/lib/help/content';
import type { PartnerWidgetReport } from '@/lib/analytics/widget-census-types';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; report: PartnerWidgetReport };

/** Причина отказа из ответа сервера или код ответа — не «ничего нет». */
async function failureText(res: Response): Promise<string> {
  const json: unknown = await res.json().catch(() => null);
  const error = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
    ? (json as { error: string }).error
    : null;
  return error ?? `сервер ответил ${res.status}`;
}

/** Один запрос к роуту → исход экрана; отказ не глушится, а называется. */
async function fetchReport(): Promise<State> {
  try {
    const res = await fetch('/api/hub/operator/widget');
    if (!res.ok) return { kind: 'error', message: await failureText(res) };
    const json: unknown = await res.json().catch(() => null);
    const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : null;
    const report = parsePartnerWidgetReport(data);
    return report ? { kind: 'ok', report } : { kind: 'error', message: 'ответ сервера не разобрался' };
  } catch {
    return { kind: 'error', message: 'нет связи с сервером' };
  }
}

export default function WidgetClient() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    void fetchReport().then((next) => { if (alive) setState(next); });
    return () => { alive = false; };
  }, []);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    void fetchReport().then(setState);
  }, []);

  if (state.kind === 'loading') {
    return <div className="p-6"><LoadingSpinner message="Загружаем виджет…" /></div>;
  }

  if (state.kind === 'error') {
    return (
      <div className="p-6">
        <EmptyState
          icon={<AlertTriangle className="w-10 h-10 text-[var(--warning)]" />}
          title="Данные виджета не загрузились"
          description={state.message}
          action={{ label: 'Повторить', onClick: retry }}
        />
      </div>
    );
  }

  const { report } = state;
  const { partner } = report;

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <header>
        <h1 className="ds-h1">Виджет на ваш сайт</h1>
        <p className="text-sm text-[var(--text-secondary)] mt-2">
          Чат с Кузьмичом и кнопка заявки на сайте вашей компании. Заявки с формы приходят вам, а не в общий пул.
        </p>
      </header>

      <section className="ds-section space-y-2" aria-labelledby="widget-status">
        <h2 id="widget-status" className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
          <Power className="w-4 h-4 text-[var(--text-muted)]" aria-hidden /> Состояние
        </h2>
        {partner.widget_enabled ? (
          <p className="text-sm text-[var(--success)] font-medium">Виджет включён</p>
        ) : (
          <>
            <p className="text-sm text-[var(--warning)] font-medium">Виджет выключен</p>
            <p className="text-sm text-[var(--text-secondary)]">
              Включает его администратор Ведара — напишите на{' '}
              <a href={`mailto:${SUPPORT.email}`} className="text-[var(--ocean)] hover:underline">{SUPPORT.email}</a>,
              и код вставки появится здесь. Пока виджет выключен, кнопка заявки на сайте не появится, а чат не загрузится.
            </p>
          </>
        )}
      </section>

      {partner.widget_enabled && (
        <section className="ds-section space-y-3" aria-labelledby="widget-codes">
          <h2 id="widget-codes" className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
            <Code2 className="w-4 h-4 text-[var(--text-muted)]" aria-hidden /> Код вставки
          </h2>
          <WidgetEmbedCodes slug={partner.slug} />
        </section>
      )}

      <section className="ds-section space-y-2" aria-labelledby="widget-domains">
        <h2 id="widget-domains" className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
          <Globe className="w-4 h-4 text-[var(--text-muted)]" aria-hidden /> Домены вашего сайта
        </h2>
        {partner.widget_domains.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Домены из списка">
            {partner.widget_domains.map((d) => (
              <li key={d} className="ds-badge">{d}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">Не указаны.</p>
        )}
        <p className="text-xs text-[var(--text-muted)]">
          Список ведёт администратор Ведара: чтобы добавить или убрать домен, напишите на {SUPPORT.email}.
          Список ничего не запирает — виджет работает на любом сайте, а по списку видно, пришёл ли посетитель с вашего.
        </p>
      </section>

      <section className="ds-section space-y-3" aria-labelledby="widget-report">
        <h2 id="widget-report" className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
          <BarChart3 className="w-4 h-4 text-[var(--text-muted)]" aria-hidden /> За 30 дней
        </h2>
        <WidgetUsageReport report={report} />
      </section>
    </div>
  );
}
