'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Search, Database, Globe, MapPin, RefreshCw, ChevronLeft, ChevronRight, AlertTriangle } from 'lucide-react';

/**
 * База знаний — перечень мест и маршрутов, которыми располагает Кузьмич.
 *
 * 03.09: страница переехала из раздела AI в «Контент» и читает master-таблицы
 * places и kamchatka_routes напрямую (API), а не VIEW agent_route_knowledge.
 * У строки появился род (место / маршрут) и ссылка на публичную карточку.
 * Статистика троична: отказ запроса показывается словами «не посчитано»,
 * а не нулём (§4.0).
 */
interface KnowledgeRoute {
  id: string;
  kind: 'place' | 'route';
  title: string;
  category: string | null;
  description: string | null;
  source_url: string | null;
  source_name: string | null;
  lat: number | null;
  lng: number | null;
  difficulty: string | null;
  duration: string | null;
  season: string | null;
  price_from: string | null;
  has_embedding: boolean;
  created_at: string;
  updated_at: string;
}

interface KnowledgeStats {
  totals: { total: number; embedded: number; places: number; routes: number } | null;
  categories: Array<{ category: string; count: number }> | null;
  sources: Array<{ source: string; count: number }> | null;
  failures: string[];
}

const CATEGORY_LABELS: Record<string, string> = {
  vulkani: 'Вулканы',
  geyzery: 'Гейзеры',
  termalnye_istochniki: 'Термальные',
  rybalka: 'Рыбалка',
  snegohod: 'Снегоход',
  dzhip: 'Джип',
  morskie_progulki: 'Морские',
  trekking: 'Треккинг',
  lakes: 'Озёра',
  mountains: 'Горы',
  rivers: 'Реки',
  medvedi: 'Медведи',
  vertoletnye_tury: 'Вертолёт',
  eco: 'Эко',
};

const KIND_LABELS: Record<KnowledgeRoute['kind'], string> = { place: 'Место', route: 'Маршрут' };

function hrefFor(row: KnowledgeRoute): string {
  return row.kind === 'place' ? `/places/${row.id}` : `/routes/${row.id}`;
}

function StatCard({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3.5">
      <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">{label}</p>
      <div className="flex items-end gap-2">
        {value === null ? (
          <span className="text-sm text-[var(--warning)]">не посчитано</span>
        ) : (
          <span className="text-xl font-semibold text-[var(--text-primary)] font-mono">{value}</span>
        )}
        {hint && value !== null && (
          <span className="text-xs text-[var(--text-muted)] font-mono mb-0.5">{hint}</span>
        )}
      </div>
    </div>
  );
}

export default function KnowledgeBasePage() {
  const [routes, setRoutes] = useState<KnowledgeRoute[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const fetchStats = useCallback(async () => {
    setStatsError(null);
    try {
      const res = await fetch('/api/admin/knowledge/stats');
      const json = await res.json() as { success: boolean; data?: KnowledgeStats; error?: string };
      if (json.success && json.data) setStats(json.data);
      else setStatsError(json.error ?? `Ответ ${res.status}`);
    } catch {
      setStatsError('Запрос не ушёл — проверьте сеть');
    }
  }, []);

  const fetchRoutes = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '30' });
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      if (kind) params.set('kind', kind);
      const res = await fetch(`/api/admin/knowledge?${params}`);
      const json = await res.json() as {
        success: boolean;
        data?: { routes: KnowledgeRoute[]; totalPages: number; total: number };
        error?: string;
      };
      if (json.success && json.data) {
        setRoutes(json.data.routes);
        setTotalPages(json.data.totalPages);
        setTotal(json.data.total);
      } else {
        setListError(json.error ?? `Ответ ${res.status}`);
      }
    } catch {
      setListError('Запрос не ушёл — проверьте сеть');
    }
    setLoading(false);
  }, [page, search, category, kind]);

  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchRoutes(); }, [fetchRoutes]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchRoutes();
  };

  const totals = stats?.totals ?? null;
  const embeddedPct = totals && totals.total > 0 ? `${Math.round((totals.embedded / totals.total) * 100)}%` : undefined;

  return (
    <div className="p-5 lg:p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Database className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">База знаний</h1>
        </div>
        <button
          onClick={() => { fetchStats(); fetchRoutes(); }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Обновить
        </button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Места и маршруты, которыми располагает Кузьмич: источник, координаты и вектор для поиска.
        Правятся они на своих экранах — «Редактор мест» и «Модерация маршрутов».
      </p>

      {/* Stats */}
      {statsError && (
        <p className="text-xs text-[var(--danger)]">Статистика не прочитана: {statsError}</p>
      )}
      {stats && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Мест" value={totals ? totals.places : null} />
            <StatCard label="Маршрутов" value={totals ? totals.routes : null} />
            <StatCard label="С вектором поиска" value={totals ? totals.embedded : null} hint={embeddedPct} />
            <StatCard label="Источников" value={stats.sources ? stats.sources.length : null} />
          </div>
          {stats.failures.length > 0 && (
            <div className="flex items-start gap-2 text-xs text-[var(--warning)]">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>Часть счётчиков не посчитана — это отказ запроса, а не пустота: {stats.failures.join('; ')}</span>
            </div>
          )}
        </>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder="Поиск по названию..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
          <button
            type="submit"
            className="px-3 py-2 text-xs bg-[var(--accent)] text-white rounded-md hover:opacity-90 transition-opacity"
          >
            Найти
          </button>
        </form>
        <select
          value={kind}
          onChange={e => { setKind(e.target.value); setPage(1); }}
          className="px-3 py-2 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="">Места и маршруты</option>
          <option value="place">Только места</option>
          <option value="route">Только маршруты</option>
        </select>
        <select
          value={category}
          onChange={e => { setCategory(e.target.value); setPage(1); }}
          className="px-3 py-2 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="">Все категории</option>
          {stats?.categories?.map(c => (
            <option key={c.category} value={c.category}>
              {CATEGORY_LABELS[c.category] ?? c.category} ({c.count})
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--text-secondary)]">Записи</span>
          <span className="text-[10px] text-[var(--text-muted)] font-mono">{total} найдено</span>
        </div>

        {loading ? (
          <div className="px-4 py-16 text-center">
            <div className="inline-block w-5 h-5 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
          </div>
        ) : listError ? (
          <p className="px-4 py-16 text-center text-xs text-[var(--danger)]">Перечень не прочитан: {listError}</p>
        ) : routes.length === 0 ? (
          <p className="px-4 py-16 text-center text-xs text-[var(--text-muted)]">По этим условиям записей нет</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="px-4 py-2 text-left font-medium">Название</th>
                  <th className="py-2 text-left font-medium">Род</th>
                  <th className="py-2 text-left font-medium">Категория</th>
                  <th className="py-2 text-left font-medium">Источник</th>
                  <th className="py-2 text-center font-medium">Сложность</th>
                  <th className="py-2 text-center font-medium">Длительность</th>
                  <th className="py-2 text-center font-medium">Координаты</th>
                  <th className="py-2 text-center font-medium">Вектор</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {routes.map(route => (
                  <tr key={`${route.kind}:${route.id}`} className="hover:bg-[var(--bg-hover)] transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="max-w-[300px]">
                        <Link href={hrefFor(route)} className="text-[var(--text-primary)] truncate font-medium block hover:text-[var(--ocean)]">
                          {route.title}
                        </Link>
                        {route.description && (
                          <p className="text-[var(--text-muted)] truncate mt-0.5">{route.description}</p>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 text-[var(--text-secondary)]">{KIND_LABELS[route.kind]}</td>
                    <td className="py-2.5">
                      <span className="inline-flex px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-hover)] text-[var(--text-secondary)]">
                        {route.category ? (CATEGORY_LABELS[route.category] ?? route.category) : '—'}
                      </span>
                    </td>
                    <td className="py-2.5">
                      {route.source_url ? (
                        <a
                          href={route.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[var(--accent)] hover:underline"
                        >
                          <Globe className="w-3 h-3" />
                          {route.source_name ?? 'Источник'}
                        </a>
                      ) : (
                        <span className="text-[var(--text-muted)]">{route.source_name ?? '—'}</span>
                      )}
                    </td>
                    <td className="py-2.5 text-center text-[var(--text-secondary)]">{route.difficulty ?? '—'}</td>
                    <td className="py-2.5 text-center text-[var(--text-secondary)]">{route.duration ?? '—'}</td>
                    <td className="py-2.5 text-center">
                      {route.lat && route.lng ? (
                        <MapPin className="w-3 h-3 text-[var(--success)] mx-auto" />
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="py-2.5 text-center">
                      <span
                        title={route.has_embedding ? 'вектор есть' : 'вектора нет'}
                        className={`inline-block w-2 h-2 rounded-full ${route.has_embedding ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]/30'}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-[var(--border)] flex items-center justify-between">
            <span className="text-[10px] text-[var(--text-muted)]">
              Стр. {page} из {totalPages}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-30 transition-colors"
              >
                <ChevronLeft className="w-3 h-3 text-[var(--text-muted)]" />
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="w-3 h-3 text-[var(--text-muted)]" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sources breakdown */}
      {stats?.sources && stats.sources.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <span className="text-xs font-medium text-[var(--text-secondary)]">Источники данных</span>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {stats.sources.map(s => (
              <div key={s.source} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs text-[var(--text-primary)]">{s.source}</span>
                <span className="text-xs text-[var(--text-muted)] font-mono">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
