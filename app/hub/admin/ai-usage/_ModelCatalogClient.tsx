'use client';

/**
 * Вкладка «Модели и цены».
 *
 * Показывает не прайс, а СЧЁТ ЗА НАШУ РАБОТУ. Прайс сам по себе не сравним:
 * модель с дорогим выводом и дешёвым входом выигрывает там, где работа
 * входо-тяжёлая (судья читает много, отвечает строкой), и проигрывает там,
 * где выходо-тяжёлая (Editor читает мало, пишет абзац). У нас есть обе.
 *
 * Свежесть и происхождение чисел названы словами, а не подразумеваются:
 * каталог привозит раннер (прод спросить OpenRouter не может — 403), а формы
 * работы — оценка из потолков в коде, не замер.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, AlertTriangle, Clock, Info } from 'lucide-react';

interface Workload {
  key: string;
  title: string;
  calls: number;
  inTokens: number;
  outTokens: number;
  basis: string;
  runsPerDay: number;
}

interface ModelRow {
  model_id: string;
  vendor: string;
  display_name: string | null;
  usd_per_mtok_in: number | null;
  usd_per_mtok_out: number | null;
  context_length: number | null;
  in_latest_batch: boolean;
  cost: Record<string, { per_run_usd: number | null; per_month_usd: number | null }>;
}

interface Payload {
  freshness: {
    state: 'fresh' | 'stale' | 'never';
    latest_at: string | null;
    hours_ago: number | null;
    models_total: number;
    stale_after_hours?: number;
  };
  estimated: boolean;
  workloads: Workload[];
  models: ModelRow[];
  note?: string;
}

/** «Не назвал цену» и «ноль» — разные вещи, и выглядеть должны по-разному. */
function money(v: number | null, digits = 2): string {
  return v === null ? 'не назвал' : `$${v.toFixed(digits)}`;
}

function perMtok(v: number | null): string {
  if (v === null) return 'не назвал';
  if (v === 0) return 'бесплатно';
  return `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
}

export default function ModelCatalogClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [workload, setWorkload] = useState('judge');

  const load = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/model-catalog?limit=200${query ? `&q=${encodeURIComponent(query)}` : ''}`);
      const json = await res.json();
      if (json.success) setData(json as Payload);
      else setError(json.error ?? 'Каталог не загрузился');
    } catch {
      setError('Каталог не загрузился — сеть или сервер');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(''); }, [load]);

  const current = useMemo(
    () => data?.workloads.find((w) => w.key === workload) ?? data?.workloads[0] ?? null,
    [data, workload],
  );

  const fresh = data?.freshness;

  return (
    <div className="space-y-4">
      {/* Свежесть — первое, что видно. Цена из позавчерашнего каталога и цена
          сегодняшняя выглядят одинаково, и различить их должна страница. */}
      {fresh && (
        <div
          className={`flex items-start gap-2 p-3 rounded-lg border text-xs ${
            fresh.state === 'fresh'
              ? 'border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-secondary)]'
              : 'border-[var(--warning)] bg-[var(--bg-card)] text-[var(--text-primary)]'
          }`}
        >
          {fresh.state === 'fresh' ? <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--ocean)]" />
            : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--warning)]" />}
          <span>
            {fresh.state === 'never' && (data?.note ?? 'Каталог ни разу не приезжал.')}
            {fresh.state === 'stale' && (
              <>Каталог снят {fresh.hours_ago} ч назад — прогон не приходил дольше обычного.
                Цены на экране могут быть старыми: прод спросить OpenRouter не может, каталог везёт раннер.</>
            )}
            {fresh.state === 'fresh' && (
              <>Каталог снят {fresh.hours_ago} ч назад, моделей в базе {fresh.models_total}.
                Прод спрашивает OpenRouter не сам — цены привозит прогон <code>model-catalog.yml</code>.</>
            )}
          </span>
        </div>
      )}

      {data?.estimated && current && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] text-xs text-[var(--text-secondary)]">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--ocean)]" />
          <span>
            Счёт считается по ОЦЕНКЕ объёма, а не по замеру: {current.basis}. Настоящий
            расход появится здесь, когда флагманская ступень начнёт писать usage — сейчас
            самый дорогой путь не пишет его вовсе, и в журнале его расхода нет.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(q); }}
            placeholder="glm, opus, deepseek..."
            className="ds-input flex-1 text-xs py-1.5"
          />
        </div>
        <select
          value={workload}
          onChange={(e) => setWorkload(e.target.value)}
          className="ds-input text-xs py-1.5"
          aria-label="Форма работы"
        >
          {(data?.workloads ?? []).map((w) => (
            <option key={w.key} value={w.key}>{w.title}</option>
          ))}
        </select>
        <button
          onClick={() => load(q)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Обновить
        </button>
      </div>

      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      {loading && <div className="ds-skeleton h-40 rounded-lg" />}

      {!loading && data && data.models.length === 0 && (
        <p className="text-xs text-[var(--text-secondary)]">
          {fresh?.state === 'never'
            ? 'Выбирать не из чего не потому, что моделей нет, а потому что каталог не приезжал.'
            : 'По этому запросу в каталоге ничего нет.'}
        </p>
      )}

      {!loading && data && data.models.length > 0 && current && (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-hover)] text-[var(--text-secondary)]">
              <tr>
                <th className="text-left font-medium px-3 py-2">Модель</th>
                <th className="text-right font-medium px-3 py-2">Вход $/млн</th>
                <th className="text-right font-medium px-3 py-2">Выход $/млн</th>
                <th className="text-right font-medium px-3 py-2">Контекст</th>
                <th className="text-right font-medium px-3 py-2">За прогон</th>
                <th className="text-right font-medium px-3 py-2">В месяц</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m) => {
                const c = m.cost[current.key];
                return (
                  <tr key={m.model_id} className="border-t border-[var(--border)] hover:bg-[var(--bg-hover)]">
                    <td className="px-3 py-2">
                      <span className="text-[var(--text-primary)]">{m.model_id}</span>
                      {!m.in_latest_batch && (
                        <span className="ml-2 text-[var(--warning)]">выбыла из каталога</span>
                      )}
                      {m.display_name && (
                        <div className="text-[var(--text-muted)]">{m.display_name}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--text-secondary)]">{perMtok(m.usd_per_mtok_in)}</td>
                    <td className="px-3 py-2 text-right text-[var(--text-secondary)]">{perMtok(m.usd_per_mtok_out)}</td>
                    <td className="px-3 py-2 text-right text-[var(--text-muted)]">
                      {m.context_length === null ? 'не назвал' : m.context_length.toLocaleString('ru-RU')}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--text-primary)]">{money(c?.per_run_usd ?? null)}</td>
                    <td className="px-3 py-2 text-right text-[var(--text-secondary)]">{money(c?.per_month_usd ?? null, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
