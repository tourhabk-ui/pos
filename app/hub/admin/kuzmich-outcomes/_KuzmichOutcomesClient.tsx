'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { ClipboardCopy, Loader2, MessageSquareWarning } from 'lucide-react';
import { casesForReview, type OutcomeCase } from '@/lib/kuzmich/bad-outcome-cases';

interface Data { days: number; outcomes_total: number; cases: OutcomeCase[]; truncated: boolean }

const SURFACE_LABEL: Record<string, string> = {
  telegram: 'Telegram', max: 'MAX', other: 'Мессенджер', web: 'Сайт', 'web-stream': 'Сайт',
  widget: 'Виджет партнёра', a2a: 'Агент A2A',
};

const DAY_OPTIONS = [7, 30, 90];

/**
 * Плохие оценки Кузьмича случаями (#3179). Еженедельный свод в публичном
 * репозитории называет только числа и номера; здесь их можно открыть:
 * вопрос, ответ и слова судьи. Телефоны и почта скрыты. Кнопка копирует
 * видимые случаи текстом — для разбора, без номеров чатов и служебных полей.
 */
export default function KuzmichOutcomesClient() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cluster, setCluster] = useState<string | null>(null);
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/kuzmich-outcomes?days=${days}`);
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string; data?: Data } | null;
      if (!res.ok || !json?.success || !json.data) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setData(json.data);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Оценки не загрузились');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const m = new Map<string, { label: string; n: number }>();
    for (const c of data?.cases ?? []) {
      for (const k of c.clusters) {
        const cur = m.get(k.id) ?? { label: k.label, n: 0 };
        cur.n += 1;
        m.set(k.id, cur);
      }
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [data]);

  const visible = useMemo(
    () => (data?.cases ?? []).filter((c) => !cluster || c.clusters.some((k) => k.id === cluster)),
    [data, cluster],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(casesForReview(visible));
      setCopied(`Скопировано случаев: ${visible.length}`);
    } catch {
      setCopied('Не скопировалось — выделите текст вручную');
    }
  }

  return (
    <Protected roles={['admin']}>
      <main className="space-y-6 p-4 md:p-6">
        <header className="space-y-2">
          <h1 className="ds-h1 flex items-center gap-2"><MessageSquareWarning className="w-6 h-6" /> Кузьмич: плохие оценки</h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-3xl">
            Ответы, которые судья оценил ниже 7 из 10, ответы с фактами без вызова инструментов и отказы модели.
            Вопрос и ответ сохранены обрезанными (150 и 300 знаков), телефоны и почта скрыты. Судья — тоже модель:
            его слова — повод посмотреть, а не приговор.
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--text-secondary)]">За</span>
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days === d}
                onClick={() => { setDays(d); setCluster(null); }}
                className={`ds-btn ${days === d ? 'ds-btn-primary' : 'ds-btn-secondary'}`}
              >
                {d} дн.
              </button>
            ))}
          </div>
        </header>

        {error && <p role="alert" className="text-sm text-[var(--danger)]">Оценки не загрузились: {error}</p>}
        {loading ? (
          <p className="flex items-center gap-2 text-[var(--text-secondary)]"><Loader2 className="w-4 h-4 animate-spin" /> Загружаю…</p>
        ) : !data ? null : (
          <>
            <p className="text-sm text-[var(--text-primary)]">
              Плохих: <strong>{data.cases.length}{data.truncated ? '+' : ''}</strong> из {data.outcomes_total} сохранённых оценок за {data.days} дн.
              {data.truncated && ' Показаны последние 200 — сузьте окно.'}
            </p>
            {data.cases.length === 0 ? (
              <p className="text-[var(--text-secondary)]">
                {data.outcomes_total === 0
                  ? 'За это окно оценок нет вовсе — судья не писал. Это не значит, что ответы хорошие.'
                  : 'Плохих оценок за это окно нет.'}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 text-sm" role="group" aria-label="Тип проблемы">
                  <button type="button" aria-pressed={cluster === null} onClick={() => setCluster(null)} className={`ds-btn ${cluster === null ? 'ds-btn-primary' : 'ds-btn-secondary'}`}>
                    Все ({data.cases.length})
                  </button>
                  {counts.map(([id, { label, n }]) => (
                    <button key={id} type="button" aria-pressed={cluster === id} onClick={() => setCluster(id)} className={`ds-btn ${cluster === id ? 'ds-btn-primary' : 'ds-btn-secondary'}`}>
                      {label} ({n})
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={copy} className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
                    <ClipboardCopy className="w-4 h-4" /> Скопировать показанные для разбора
                  </button>
                  {copied && <span role="status" className="text-sm text-[var(--text-secondary)]">{copied}</span>}
                </div>
                <ul className="space-y-4">
                  {visible.map((c) => (
                    <li key={c.id} className="ds-card p-4 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className={`ds-badge ${c.refusal ? 'text-[var(--warning)]' : 'text-[var(--danger)]'}`}>
                          {c.refusal ? 'Отказ модели' : `Оценка ${c.score ?? '—'}/10`}
                        </span>
                        <span className="text-[var(--text-secondary)]">
                          #{c.id} · {c.surface ? SURFACE_LABEL[c.surface] ?? c.surface : 'поверхность не записана'}
                          {' · '}{new Date(c.created_at).toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka' })}
                          {' · '}{c.tools.length > 0 ? `инструменты: ${c.tools.join(', ')}` : 'без инструментов'}
                          {c.provider ? ` · ${c.provider}` : ''}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {c.clusters.map((k) => <span key={k.id} className="ds-badge">{k.label}</span>)}
                      </div>
                      <dl className="space-y-1 text-sm">
                        <dt className="font-semibold text-[var(--text-primary)]">Вопрос</dt>
                        <dd className="whitespace-pre-wrap text-[var(--text-secondary)]">{c.question || 'не сохранён'}</dd>
                        <dt className="font-semibold text-[var(--text-primary)]">Ответ Кузьмича</dt>
                        <dd className="whitespace-pre-wrap text-[var(--text-secondary)]">{c.answer || 'не сохранён'}</dd>
                        <dt className="font-semibold text-[var(--text-primary)]">Судья</dt>
                        <dd className="text-[var(--text-secondary)]">
                          {c.issues.length > 0 ? (
                            <ul className="list-disc pl-5">{c.issues.map((s, i) => <li key={i}>{s}</li>)}</ul>
                          ) : 'проблем не названо'}
                        </dd>
                      </dl>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </main>
    </Protected>
  );
}
