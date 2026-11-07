'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Coins, RefreshCw, Cpu, Sparkles, Tags, Wallet } from 'lucide-react';
import AiMoneyClient from './_AiMoneyClient';
import KuzmichAnalyticsClient from './_KuzmichAnalyticsClient';
import ModelCatalogClient from './_ModelCatalogClient';

/**
 * Четыре вкладки на одном вопросе «во что нам обходится AI» (03.09, +09.09,
 * +07.11 «Деньги» первой).
 *
 * «Расходы AI» и «AI Кузьмич» читали один и тот же журнал ai_actions_log с
 * двух страниц в разных разделах меню: первая — сколько и каким провайдером,
 * вторая — те же действия глазами чатов с Кузьмичом. Два входа на один
 * источник — это не два инструмента, а один, показанный дважды. Вкладка
 * берётся из адреса (?tab=kuzmich), чтобы старые ссылки и редирект со
 * снятого /hub/admin/ai-analytics открывали именно её.
 */
// Третья вкладка (09.09) — цены моделей. Здесь же, а не отдельной страницей:
// «сколько потратили» и «сколько стоит» — один вопрос, и разведённый по двум
// разделам меню он читался бы как два разных инструмента (§12).
//
// 07.11 (владелец: «как смотреть расходы и за что», «наведи порядок в этом
// разделе»): первой и по умолчанию — «Деньги» (книги llm_usage_log: сегодня
// против лимита, за что по агентам, по моделям, остаток на счетах; карточка
// переехала сюда из «Health-метрик»). Счётчик действий стал вкладкой
// «Активность» и больше не показывает «стоимость пока не пишется» — по
// колонке ai_actions_log.cost_usd, которую не пишет никто.
type UsageTab = 'money' | 'activity' | 'kuzmich' | 'models';

function tabFromLocation(): UsageTab {
  if (typeof window === 'undefined') return 'money';
  const t = new URLSearchParams(window.location.search).get('tab');
  return t === 'activity' || t === 'kuzmich' || t === 'models' ? t : 'money';
}

interface AiUsageData {
  totals: { today: number; week: number; month: number };
  by_action_type: Array<{ action_type: string; count: number }>;
  by_provider: Array<{ provider: string; count: number }>;
  daily: Array<{ day: string; count: number }>;
}

export default function AdminAiUsagePage() {
  const [tab, setTab] = useState<UsageTab>('money');
  // Адрес читается после монтирования: на сервере window нет, а рендер с
  // разной вкладкой на сервере и клиенте дал бы расхождение разметки.
  useEffect(() => { setTab(tabFromLocation()); }, []);
  const switchTab = (next: UsageTab) => {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      if (next === 'money') url.searchParams.delete('tab');
      else url.searchParams.set('tab', next);
      window.history.replaceState(null, '', url.toString());
    } catch { /* адрес не обновился — переключение всё равно состоялось */ }
  };

  const [data, setData] = useState<AiUsageData | null>(null);
  const [loading, setLoading] = useState(false);
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

  // Счётчик читается, когда открыта его вкладка: по умолчанию страница
  // открывается на «Деньгах», и лишний запрос к журналу действий не нужен.
  useEffect(() => {
    if (tab === 'activity' && data === null && !loading && error === null) void fetchData();
  }, [tab, data, loading, error, fetchData]);

  const kpis = data ? [
    { label: 'Сегодня', value: data.totals.today },
    { label: '7 дней', value: data.totals.week },
    { label: '30 дней', value: data.totals.month },
  ] : [];

  const maxDaily = data ? Math.max(...data.daily.map(d => d.count), 1) : 1;
  const maxType = data ? Math.max(...data.by_action_type.map(t => t.count), 1) : 1;
  const maxProvider = data ? Math.max(...data.by_provider.map(p => p.count), 1) : 1;

  const tabs: Array<{ id: UsageTab; label: string; Icon: typeof Coins }> = [
    { id: 'money', label: 'Деньги', Icon: Wallet },
    { id: 'activity', label: 'Активность', Icon: Activity },
    { id: 'kuzmich', label: 'Кузьмич', Icon: Sparkles },
    { id: 'models', label: 'Модели и цены', Icon: Tags },
  ];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Coins className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Расходы AI</h1>
        </div>
        {tab === 'activity' && (
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Обновить
          </button>
        )}
      </div>

      {/* Вкладки: один журнал — два взгляда. Кнопки, не ссылки: адрес обновляется
          replaceState, страница не перезагружается. */}
      <div role="tablist" className="flex gap-1 border-b border-[var(--border)]">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => switchTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
              tab === id
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      {tab === 'money' ? (
        <AiMoneyClient />
      ) : tab === 'models' ? (
        <ModelCatalogClient />
      ) : tab === 'kuzmich' ? (
        <KuzmichAnalyticsClient />
      ) : (
      <>
      <p className="text-xs text-[var(--text-muted)]">
        Сколько раз агенты что-то делали — по дням, по типу действия, по провайдеру
        (журнал ai_actions_log). Это счётчик, а не деньги: сколько это стоит — во
        вкладке «Деньги».
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
      </>
      )}
    </div>
  );
}
