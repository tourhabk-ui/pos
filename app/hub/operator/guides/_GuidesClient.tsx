'use client';

import { useCallback, useEffect, useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { Users, Star, Loader2, Search, UserCheck, UserX, AlertTriangle } from 'lucide-react';

/**
 * Гиды оператора — живой экран.
 *
 * До аудита бизнес-процессов 25.07 здесь стояли три выдуманных гида с
 * придуманными рейтингами и кнопка «Отключить», которая меняла только
 * локальный стейт. Экран переведён на GET/PATCH /api/operator/guides
 * поверх partners.guide_operator_id (миграция 121).
 */

interface Guide {
  id: string;
  name: string;
  rating: number | null;
  specializations: string[];
  isAvailable: boolean;
  toursCount: number;
}

export default function GuidesClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/guides');
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || 'Не удалось загрузить гидов');
        setGuides([]);
        return;
      }
      setGuides(json.data ?? []);
    } catch {
      setError('Сеть недоступна. Список гидов не загружен.');
      setGuides([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggle(guide: Guide) {
    setBusyId(guide.id);
    setError(null);
    try {
      const res = await fetch('/api/operator/guides', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guideId: guide.id, isAvailable: !guide.isAvailable }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || 'Не удалось изменить доступность гида');
        return;
      }
      setGuides((prev) =>
        prev.map((g) => (g.id === guide.id ? { ...g, isAvailable: !g.isAvailable } : g)),
      );
    } catch {
      setError('Сеть недоступна. Изменение не сохранено.');
    } finally {
      setBusyId(null);
    }
  }

  const filtered = guides.filter((g) => g.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <Protected roles={['operator', 'admin']}>
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-[var(--accent)]" />
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">Гиды</h1>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск гида..."
              className="min-h-[44px] pl-10 pr-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-4 mb-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-sm text-[var(--text-primary)]">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Users className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-[var(--text-secondary)]">
              {guides.length === 0 ? 'К вашей компании пока не привязан ни один гид' : 'Никто не найден'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((guide) => (
              <div
                key={guide.id}
                className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 flex items-center justify-between gap-4 flex-wrap"
              >
                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-[var(--text-primary)]">{guide.name}</p>
                    {guide.isAvailable ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--success)]/15 text-[var(--success)]">
                        Активен
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--text-muted)]/15 text-[var(--text-muted)]">
                        Неактивен
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-sm text-[var(--text-secondary)] flex-wrap">
                    {guide.rating !== null && (
                      <span className="flex items-center gap-1">
                        <Star className="w-3.5 h-3.5 text-[var(--warning)] fill-[var(--warning)]" />
                        {guide.rating.toFixed(1)}
                      </span>
                    )}
                    <span>{guide.toursCount} выходов</span>
                    {guide.specializations.length > 0 && <span>{guide.specializations.join(', ')}</span>}
                  </div>
                </div>
                <button
                  onClick={() => toggle(guide)}
                  disabled={busyId === guide.id}
                  className="min-h-[44px] px-3 py-2 rounded-lg text-sm border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                >
                  {busyId === guide.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : guide.isAvailable ? (
                    <><UserX className="w-4 h-4" /> Отключить</>
                  ) : (
                    <><UserCheck className="w-4 h-4" /> Включить</>
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Protected>
  );
}
