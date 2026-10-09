'use client';

import { useCallback, useEffect, useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { Check, Loader2, ShieldAlert, X } from 'lucide-react';

interface Claim { kind: 'all_clear' | 'hazard'; phrase: string; hazard?: string }
interface Item {
  id: string; created_at: string; surface: string; verdict: string;
  claims: Claim[]; flagged: Claim[]; tools: string[]; reply_excerpt: string;
  review_mark: 'correct' | 'wrong' | null; review_note: string | null;
}
interface Count { verdict: string; open: number; total: number }

/** Вердикт сверки — словами для человека, а не ключом. */
const VERDICT_LABEL: Record<string, string> = {
  contradicted: '«Безопасно» вопреки данным',
  unbacked: 'Без опоры в данных',
  unverifiable: 'Проверить было не с чем',
  backed: 'Опирается на данные',
};

const SURFACE_LABEL: Record<string, string> = {
  telegram: 'Telegram', max: 'MAX', other: 'Мессенджер', web: 'Сайт', 'web-stream': 'Сайт',
};

/**
 * Разбор утверждений Кузьмича о безопасности (#2300). Ответы уже ушли
 * туристу — сверка с данными делается автоматом до отправки, а здесь человек
 * отмечает, где сторож или модель ошиблись. Отметки — материал для правки
 * сторожа и промпта, а не способ задержать предупреждение.
 */
export default function KuzmichSafetyClient() {
  const [items, setItems] = useState<Item[]>([]);
  const [counts, setCounts] = useState<Count[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/kuzmich-safety${showAll ? '?status=all' : ''}`);
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string; data?: { items: Item[]; counts: Count[] } } | null;
      if (!res.ok || !json?.success || !json.data) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setItems(json.data.items);
      setCounts(json.data.counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Список не загрузился');
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => { void load(); }, [load]);

  async function mark(id: string, value: 'correct' | 'wrong') {
    setActing(id);
    try {
      const res = await fetch(`/api/admin/kuzmich-safety/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mark: value }),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!res.ok || !json?.success) throw new Error(json?.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Отметка не записалась');
    } finally {
      setActing(null);
    }
  }

  return (
    <Protected roles={['admin']}>
      <main className="space-y-6 p-4 md:p-6">
        <header className="space-y-2">
          <h1 className="ds-h1 flex items-center gap-2"><ShieldAlert className="w-6 h-6" /> Кузьмич: утверждения о безопасности</h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-3xl">
            Ответы уже ушли туристам. Перед отправкой каждое «безопасно» и каждое предупреждение сверено с данными
            инструментов того же хода: «безопасно» без данных или вопреки им получило поправку, предупреждение без
            опоры — пометку. Здесь отмечайте, где сверка или модель ошиблись. Записи хранятся 30 дней.
          </p>
          <div className="flex flex-wrap gap-2 text-sm">
            {counts.map((c) => (
              <span key={c.verdict} className="ds-badge">{VERDICT_LABEL[c.verdict] ?? c.verdict}: {c.open} из {c.total}</span>
            ))}
          </div>
          <label className="inline-flex items-center gap-2 min-h-[44px] text-sm text-[var(--text-primary)]">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-[var(--accent)]" />
            Показывать и разобранные
          </label>
        </header>

        {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
        {loading ? (
          <p className="flex items-center gap-2 text-[var(--text-secondary)]"><Loader2 className="w-4 h-4 animate-spin" /> Загружаю…</p>
        ) : items.length === 0 ? (
          <p className="text-[var(--text-secondary)]">Неразобранных записей нет.</p>
        ) : (
          <ul className="space-y-4">
            {items.map((it) => (
              <li key={it.id} className="ds-card p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={`ds-badge ${it.verdict === 'contradicted' ? 'text-[var(--danger)]' : it.verdict === 'backed' ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
                    {VERDICT_LABEL[it.verdict] ?? it.verdict}
                  </span>
                  <span className="text-[var(--text-secondary)]">
                    {SURFACE_LABEL[it.surface] ?? it.surface} · {new Date(it.created_at).toLocaleString('ru-RU')}
                    {it.tools.length > 0 ? ` · инструменты: ${it.tools.join(', ')}` : ' · без инструментов'}
                  </span>
                  {it.review_mark && <span className="ds-badge">{it.review_mark === 'correct' ? 'Отмечено: верно' : 'Отмечено: ошибка'}</span>}
                </div>
                {it.flagged.length > 0 && (
                  <p className="text-sm text-[var(--text-primary)]">
                    Помечено: {it.flagged.map((c) => `«${c.phrase}»`).join(', ')}
                  </p>
                )}
                <p className="text-sm whitespace-pre-wrap text-[var(--text-secondary)]">{it.reply_excerpt}</p>
                {!it.review_mark && (
                  <div className="flex gap-2">
                    <button type="button" disabled={acting === it.id} onClick={() => mark(it.id, 'correct')} className="ds-btn ds-btn-secondary inline-flex items-center gap-1">
                      <Check className="w-4 h-4" /> Верно
                    </button>
                    <button type="button" disabled={acting === it.id} onClick={() => mark(it.id, 'wrong')} className="ds-btn ds-btn-danger inline-flex items-center gap-1">
                      <X className="w-4 h-4" /> Ошибка
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </Protected>
  );
}
