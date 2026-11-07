'use client';

/**
 * Админка «Сторонние сервисы» (/hub/admin/taaft).
 *
 * Владелец 07.11 открыл эту страницу как «наши инструменты» — она называлась
 * «AI-инструменты». Это чужие приложения, которые советует Кузьмич и
 * показывает /ai-tools. Инструменты Ведара для ИИ-агентов и их вызовы — на
 * /hub/admin/mcp. Страница говорит это первой строкой.
 *
 * Прежде: колонка «Использований» считала попадания в ответ Кузьмича и Evo, а
 * не использования; «Рейтинг» — оценки, которых не было; не загрузилось —
 * «Инструменты не найдены» или падение страницы. Теперь: показывается ли
 * приложение туристу, щелчки людей и честное «не загрузилось».
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Globe, RefreshCw, ExternalLink } from 'lucide-react';
import { APP_CATEGORIES } from '@/lib/travel-apps/catalog';

interface AdminExternalTool {
  slug: string;
  name: string;
  description: string;
  url: string;
  category: string;
  is_free: boolean;
  verified: boolean;
  click_count: number;
  updated_at: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; tools: AdminExternalTool[] }
  | { kind: 'failed'; reason: string };

function categoryLabel(value: string): string {
  return APP_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

export default function TaaftClient() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const fetchList = useCallback(async (): Promise<LoadState> => {
    try {
      const res = await fetch('/api/admin/taaft');
      if (!res.ok) return { kind: 'failed', reason: `ответ ${res.status}` };
      const data = (await res.json()) as { tools?: AdminExternalTool[] };
      if (!Array.isArray(data.tools)) return { kind: 'failed', reason: 'ответ без списка' };
      return { kind: 'ok', tools: data.tools };
    } catch (err) {
      return { kind: 'failed', reason: err instanceof Error ? err.message : 'сеть' };
    }
  }, []);

  // Первая загрузка: состояние «загружаю» уже стоит с начала.
  useEffect(() => {
    let alive = true;
    void fetchList().then((next) => { if (alive) setState(next); });
    return () => { alive = false; };
  }, [fetchList]);

  const reload = () => {
    setState({ kind: 'loading' });
    void fetchList().then(setState);
  };

  const tools = state.kind === 'ok' ? state.tools : [];
  const shown = tools.filter((t) => t.verified).length;

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <Globe className="w-4 h-4 text-[var(--text-muted)]" aria-hidden="true" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Сторонние сервисы</h1>
          {state.kind === 'ok' && (
            <span className="text-[11px] text-[var(--text-muted)] bg-[var(--bg-hover)] px-2 py-0.5 rounded-full">
              показывается {shown} из {tools.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={reload}
          disabled={state.kind === 'loading'}
          className="flex min-h-[40px] items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--bg-hover)] text-[var(--text-secondary)] rounded-md hover:text-[var(--text-primary)] transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          Обновить
        </button>
      </div>

      <p className="text-xs text-[var(--text-secondary)] max-w-3xl">
        Это чужие приложения: их делают другие компании, Кузьмич советует их для узких задач, а страница{' '}
        <Link href="/ai-tools" className="text-[var(--ocean)] underline">«Приложения в дорогу»</Link> показывает списком.
        Это не инструменты Ведара — наши инструменты для ИИ-агентов и их вызовы на странице{' '}
        <Link href="/hub/admin/mcp" className="text-[var(--ocean)] underline">MCP</Link>.
      </p>

      <div className="ds-card overflow-hidden">
        {state.kind === 'loading' ? (
          <p className="p-8 text-center text-sm text-[var(--text-muted)]">Загружаю…</p>
        ) : state.kind === 'failed' ? (
          <p role="alert" className="p-8 text-center text-sm text-[var(--text-secondary)]">
            Список не загрузился ({state.reason}). Это сбой, а не пустой список.
          </p>
        ) : tools.length === 0 ? (
          <p className="p-8 text-center text-sm text-[var(--text-muted)]">Список пуст.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {['Сервис', 'Раздел', 'Бесплатно', 'Показывается', 'Щелчки людей', ''].map((h) => (
                    <th key={h} className="text-left text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide px-4 py-2.5">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tools.map((tool) => (
                  <tr key={tool.slug} className="border-b border-[var(--border)]">
                    <td className="px-4 py-3">
                      <p className="text-xs font-medium text-[var(--text-primary)] leading-tight">{tool.name}</p>
                      <p className="text-[11px] text-[var(--text-muted)] mt-0.5 line-clamp-2 max-w-xs">{tool.description}</p>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-[var(--text-secondary)]">{categoryLabel(tool.category)}</td>
                    <td className="px-4 py-3 text-[11px] text-[var(--text-secondary)]">{tool.is_free ? 'да' : 'нет'}</td>
                    <td className="px-4 py-3 text-[11px] text-[var(--text-secondary)]">{tool.verified ? 'да' : 'нет'}</td>
                    <td className="px-4 py-3 text-xs text-[var(--text-secondary)]">{tool.click_count}</td>
                    <td className="px-4 py-3">
                      <a
                        href={tool.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-h-[40px] items-center gap-1 whitespace-nowrap text-[11px] text-[var(--ocean)] hover:underline"
                      >
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        Открыть
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-[var(--text-muted)] max-w-3xl">
        «Щелчки людей» — сколько раз посетители открыли сайт приложения со страницы «Приложения в дорогу».
        Новое приложение добавляется миграцией с источником (как 1396), а не кнопкой: так видно, кто и по чему его проверил.
      </p>
    </div>
  );
}
