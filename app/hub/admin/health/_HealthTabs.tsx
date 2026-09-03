'use client';

import { useEffect, useState } from 'react';
import { Activity, Cpu } from 'lucide-react';
import HealthDashboardClient from './_HealthDashboardClient';
import ModelsClient from './_ModelsClient';

/**
 * Две вкладки на один вопрос «кто сейчас отвечает» (перепись админ-панели
 * 03.09, четвёртая пара). «Health-метрики» пробуют провайдеров ИИ по кнопке
 * (настоящий запрос каждому), «Модели эволюции» опрашивают у тех же
 * провайдеров /v1/models и показывают, какая модель годна решателю. Две
 * плитки в разных разделах меню на один вопрос — одна плитка.
 *
 * Оба клиента перенесены без изменений содержания. Вкладка берётся из
 * адреса (?tab=models) после монтирования: на сервере window нет, а
 * редирект со снятого /hub/admin/evo/models должен открывать именно
 * модели. По умолчанию — метрики: адрес /hub/admin/health показывает то
 * же, что и раньше.
 */
export type HealthTab = 'metrics' | 'models';

export function tabFromLocation(): HealthTab {
  if (typeof window === 'undefined') return 'metrics';
  return new URLSearchParams(window.location.search).get('tab') === 'models' ? 'models' : 'metrics';
}

export default function HealthTabs() {
  const [tab, setTab] = useState<HealthTab>('metrics');
  useEffect(() => { setTab(tabFromLocation()); }, []);

  const switchTab = (next: HealthTab) => {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      if (next === 'models') url.searchParams.set('tab', 'models');
      else url.searchParams.delete('tab');
      window.history.replaceState(null, '', url.toString());
    } catch { /* адрес не обновился — переключение всё равно состоялось */ }
  };

  const tabs: Array<{ id: HealthTab; label: string; Icon: typeof Activity }> = [
    { id: 'metrics', label: 'Метрики данных', Icon: Activity },
    { id: 'models', label: 'Модели эволюции', Icon: Cpu },
  ];

  return (
    <div>
      {/* Кнопки, не ссылки: адрес обновляется replaceState, страница не перезагружается. */}
      <div role="tablist" className="flex gap-1 border-b border-[var(--border)] px-5 lg:px-6 pt-4">
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

      {tab === 'models' ? <ModelsClient /> : <HealthDashboardClient />}
    </div>
  );
}
