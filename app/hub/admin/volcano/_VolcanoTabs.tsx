'use client';

import { useEffect, useState } from 'react';
import { Gauge, Zap } from 'lucide-react';
import VolcanoClient from './_VolcanoClient';
import AgentsClient from './_AgentsClient';

/**
 * Две вкладки на один вопрос «жив ли агент» (перепись админ-панели 03.09,
 * третья пара). «Работа Volcano OS» показывала задачи и события ядра
 * (agent_tasks / agent_events), «AI и автоматизации» — живость cron-агентов
 * (agent_run_history) и их ручной запуск. Таблицы разные, вопрос у владельца
 * один; две плитки в одном разделе меню на один вопрос — одна плитка.
 *
 * Обёртка НАМЕРЕННО тонкая: кокпит ядра (`_VolcanoClient`) остаётся
 * отдельным файлом без единой мутации — его сторож `volcano-cockpit`
 * держит это буквально, — а кнопки ручного запуска кронов живут только во
 * вкладке агентов. Оба клиента перенесены без изменений содержания.
 *
 * Вкладка берётся из адреса (?tab=agents) после монтирования: на сервере
 * window нет, а редирект со снятого /hub/admin/agents должен открывать
 * именно агентов. По умолчанию — ядро: адрес /hub/admin/volcano показывает
 * то же, что и раньше.
 */
export type VolcanoTab = 'kernel' | 'agents';

export function tabFromLocation(): VolcanoTab {
  if (typeof window === 'undefined') return 'kernel';
  return new URLSearchParams(window.location.search).get('tab') === 'agents' ? 'agents' : 'kernel';
}

export default function VolcanoTabs() {
  const [tab, setTab] = useState<VolcanoTab>('kernel');
  useEffect(() => { setTab(tabFromLocation()); }, []);

  const switchTab = (next: VolcanoTab) => {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      if (next === 'agents') url.searchParams.set('tab', 'agents');
      else url.searchParams.delete('tab');
      window.history.replaceState(null, '', url.toString());
    } catch { /* адрес не обновился — переключение всё равно состоялось */ }
  };

  const tabs: Array<{ id: VolcanoTab; label: string; Icon: typeof Gauge }> = [
    { id: 'kernel', label: 'Ядро', Icon: Gauge },
    { id: 'agents', label: 'Агенты и кроны', Icon: Zap },
  ];

  return (
    <div>
      {/* Кнопки, не ссылки: адрес обновляется replaceState, страница не перезагружается. */}
      <div role="tablist" className="flex gap-1 border-b border-[var(--border)] px-4 md:px-6 pt-4">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
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

      {tab === 'agents' ? <AgentsClient /> : <VolcanoClient />}
    </div>
  );
}
