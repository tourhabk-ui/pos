'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Coins, RefreshCw, Cpu } from 'lucide-react';

interface AiUsageData {
  totals: { today: number; week: number; month: number };
  cost: { instrumented: boolean; usd_30d: number; tokens_in_30d: number; tokens_out_30d: number };
  by_action_type: Array<{ action_type: string; count: number }>;
  by_provider: Array<{ provider: string; count: number }>;
  daily: Array<{ day: string; count: number }>;
}

export default function AdminAiUsagePage() {
  const [data, setData] = useState<AiUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/analytics/ai-usage');
      const json = await res.json();
      if (json.success) setData(json.data);
      else setError(json.error ?? 'Ошибка загрузки');
    } catch {
      setError('Ошибка загрузки статистики AI');
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const kpis = data ? [
    { label: 'Сегодня', value: data.totals.today },
    { label: '7 дней', value: data.totals.week },
    { label: '30 дней', value: data.totals.month },
  ] : [];

  const maxDaily = data ? Math.max(...data.daily.map(d => d.count), 1) : 1;
  const maxType = data ? Math.max(...data.by_action_type.map(t => t.count), 1) : 1;
  const maxProvider = data ? Math.max(...data.by_provider.map(p => p.count), 1) : 1;

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Coins className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Расходы AI</h1>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Обновить
        </button>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        Активность AI-агентов из журнала ai_actions_log: сколько раз какое действие
        отработало, каким провайдером, во времени.
      </p>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="bg-[var(--bg-card)] border border-[var(--danger)]/30 rounded-lg p-6 text-center">
          <p className="text-[var(--danger)] text-sm mb-3">{error}</p>
          <button
            onClick={fetchData}
            className="px-3 py-1.5 border border-[var(--danger)]/30 text-[var(--danger)] rounded-md text-xs transition-colors hover:bg-[var(--bg-hover)]"
          >
            Повторить
          </button>
        </div>
      ) : data && (
        <>
          {/* KPI активности */}
          <div className="grid grid-cols-3 gap-3">
            {kpis.map(k => (
              <div key={k.label} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
                <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1">{k.label}</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-semibold font-mono text-[var(--text-primary)]">{k.value.toLocaleString('ru-RU')}</span>
                  <span className="text-xs text-[var(--text-secondary)]">действий</span>
                </div>
              </div>
            ))}
          </div>

          {/* Стоимость — честно про инструментацию */}
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Стоимость · 30 дней</p>
            {data.cost.instrumented ? (
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-semibold font-mono text-[var(--text-primary)]">${data.cost.usd_30d.toFixed(2)}</span>
                  <span className="text-xs text-[var(--text-secondary)]">за 30 дней</span>
                </div>
                <span className="text-xs font-mono text-[var(--text-secondary)]">
                  {data.cost.tokens_in_30d.toLocaleString('ru-RU')} вход · {data.cost.tokens_out_30d.toLocaleString('ru-RU')} выход токенов
                </span>
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                Стоимость и токены пока не пишутся: колонки в журнале есть, но waterfall
                (callAIWaterfall/Fast/Quality) их не заполняет. Пока в стеке DeepSeek off-peak
                и бесплатные провайдеры (Groq/Cerebras/Mistral) — расход близок к нулю. Чтобы
                видеть точные рубли, нужна инструментация usage в точке AI-вызова — отдельный шаг.
              </p>
            )}
          </div>

          {/* По дням */}
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Действий по дням · 14 дней</p>
            {data.daily.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">Пока нет записей за две недели.</p>
            ) : (
              <div className="space-y-1.5">
                {data.daily.map(d => (
                  <div key={d.day} className="flex items-center gap-3">
                    <span className="text-xs font-mono text-[var(--text-secondary)] w-20 shrink-0">{d.day.slice(5)}</span>
                    <div className="flex-1 h-4 bg-[var(--bg-hover)] rounded overflow-hidden">
                      <div className="h-full bg-[var(--ocean)] rounded" style={{ width: `${(d.count / maxDaily) * 100}%` }} />
                    </div>
                    <span className="text-xs font-mono text-[var(--text-primary)] w-12 text-right shrink-0">{d.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* По типу действия */}
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
              <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">По типу действия · 30 дней</p>
              {data.by_action_type.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">Нет данных.</p>
              ) : (
                <div className="space-y-1.5">
                  {data.by_action_type.map(t => (
                    <div key={t.action_type} className="flex items-center gap-3">
                      <span className="text-xs font-mono text-[var(--text-secondary)] flex-1 truncate" title={t.action_type}>{t.action_type}</span>
                      <div className="w-24 h-3.5 bg-[var(--bg-hover)] rounded overflow-hidden shrink-0">
                        <div className="h-full bg-[var(--accent)] rounded" style={{ width: `${(t.count / maxType) * 100}%` }} />
                      </div>
                      <span className="text-xs font-mono text-[var(--text-primary)] w-10 text-right shrink-0">{t.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* По провайдеру */}
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
              <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">По провайдеру · 30 дней</p>
              {data.by_provider.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">Нет данных.</p>
              ) : (
                <div className="space-y-1.5">
                  {data.by_provider.map(p => (
                    <div key={p.provider} className="flex items-center gap-2">
                      <Cpu className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                      <span className="text-xs text-[var(--text-secondary)] flex-1 truncate" title={p.provider}>{p.provider}</span>
                      <div className="w-20 h-3.5 bg-[var(--bg-hover)] rounded overflow-hidden shrink-0">
                        <div className="h-full bg-[var(--ocean)] rounded" style={{ width: `${(p.count / maxProvider) * 100}%` }} />
                      </div>
                      <span className="text-xs font-mono text-[var(--text-primary)] w-10 text-right shrink-0">{p.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
