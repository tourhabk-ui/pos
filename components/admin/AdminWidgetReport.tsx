'use client';

/**
 * Отчёт о виджете в карточке оператора админки (аудит 15.10, находка
 * WID-screens, W7): тот же отчёт за 30 дней, что видит оператор в кабинете,
 * плюс свежая проба главных по доменам — «стоит ли код на сайте».
 *
 * Грузится по кнопке, а не при раскрытии карточки: карточек в списке много,
 * а проба ходит на чужие сайты и ждёт до 10 секунд на домен.
 *
 * Исходы (§4.0): отчёт; отказ части — «не загрузилось» у строки; отказ
 * целиком — причина словами и «Повторить», а не пустой отчёт.
 */
import { useState } from 'react';
import { BarChart3, Loader2 } from 'lucide-react';
import { WidgetUsageReport } from '@/components/widget/WidgetUsageReport';
import { parsePartnerWidgetReport } from '@/lib/embed/widget-report-view';
import type { PartnerWidgetReport } from '@/lib/analytics/widget-census-types';

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; probe: boolean; prev: PartnerWidgetReport | null }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; report: PartnerWidgetReport };

export function AdminWidgetReport({ operatorId }: { operatorId: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function load(probe: boolean) {
    setState((s) => ({ kind: 'loading', probe, prev: s.kind === 'ok' ? s.report : null }));
    try {
      const res = await fetch(`/api/admin/operators/${operatorId}/widget/report${probe ? '?probe_sites=1' : ''}`);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const error = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
          ? (json as { error: string }).error
          : `сервер ответил ${res.status}`;
        setState({ kind: 'error', message: error });
        return;
      }
      const report = parsePartnerWidgetReport(json && typeof json === 'object' ? (json as { data?: unknown }).data : null);
      setState(report ? { kind: 'ok', report } : { kind: 'error', message: 'ответ сервера не разобрался' });
    } catch {
      setState({ kind: 'error', message: 'нет связи с сервером' });
    }
  }

  if (state.kind === 'idle') {
    return (
      <button
        type="button"
        onClick={() => void load(false)}
        className="flex items-center gap-1 mt-2 text-xs text-[var(--accent)] hover:opacity-75 transition-opacity"
      >
        <BarChart3 className="w-3.5 h-3.5" aria-hidden /> Отчёт за 30 дней
      </button>
    );
  }

  if (state.kind === 'loading' && !state.prev) {
    return (
      <p className="flex items-center gap-1 mt-2 text-xs text-[var(--text-muted)]">
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> {state.probe ? 'Проверяем главные…' : 'Загружаем отчёт…'}
      </p>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="mt-2 text-xs">
        <p className="text-[var(--danger)]" role="alert">Отчёт о виджете не загрузился: {state.message}</p>
        <button type="button" onClick={() => void load(false)} className="text-[var(--accent)] hover:opacity-75 transition-opacity mt-1">
          Повторить
        </button>
      </div>
    );
  }

  const report = state.kind === 'ok' ? state.report : state.prev!;
  return (
    <div className="mt-3">
      <div className="text-xs text-[var(--text-muted)] mb-2">Виджет за 30 дней</div>
      <WidgetUsageReport
        report={report}
        showFailedMeasures
        onProbe={() => void load(true)}
        probing={state.kind === 'loading' && state.probe}
      />
    </div>
  );
}
