'use client';

import { useState, useEffect, useCallback } from 'react';
import { Cpu, Check, RefreshCw, Star, Loader2, KeyRound, type LucideIcon } from 'lucide-react';

// Какие модели провайдеров могут участвовать в эволюции. Формат ЛК туриста:
// ds-card + плитки-сетка + ds-label. Данные — из /api/admin/evo/models (живой
// /v1/models + классификатор resolver'а). Ничего не выдумываем: нет ключа —
// честно «нет ключа», модель отсеяна — показываем причину.

interface Model {
  id: string;
  eligible: boolean;
  reason: string | null;
  score: number;
}
interface Provider {
  key: string;
  label: string;
  role: string;
  override_env: string;
  override: string | null;
  active: string | null;
  auto_pick: string | null;
  eligible_count: number;
  total_count: number;
  has_key: boolean;
  models: Model[];
  /** Флагман: id запинен, а не резолвится из /v1/models — списка кандидатов нет. */
  pinned?: boolean;
  /** Пояснение к запиненному провайдеру (пути доступа, чем проверить). */
  note?: string;
}

function StatChip({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-2.5">
      <span className="flex items-center justify-center w-9 h-9 rounded-full bg-[var(--ocean)]/10">
        <Icon className="w-[18px] h-[18px] text-[var(--ocean)]" strokeWidth={1.75} />
      </span>
      <div>
        <div className="ds-label">{label}</div>
        <div className="text-sm font-bold text-[var(--text-primary)]">{value}</div>
      </div>
    </div>
  );
}

function ModelTile({ m, active }: { m: Model; active: boolean }) {
  if (!m.eligible) {
    return (
      <div className="flex flex-col gap-1 p-3 min-h-[84px] rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] opacity-80">
        <span className="text-xs font-mono text-[var(--text-muted)] line-through decoration-[var(--text-muted)]/40 break-all">{m.id}</span>
        <span className="text-[11px] text-[var(--text-muted)] leading-tight mt-auto">{m.reason}</span>
      </div>
    );
  }
  return (
    <div
      className={`flex flex-col gap-1.5 p-3 min-h-[84px] rounded-lg bg-[var(--bg-card)] border transition-colors ${
        active ? 'border-[var(--accent)] shadow-md' : 'border-[var(--border)] hover:border-[var(--ocean)]/50'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-mono font-medium text-[var(--text-primary)] break-all">{m.id}</span>
        {active && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--success)] bg-[var(--success)]/12 px-1.5 py-0.5 rounded-full whitespace-nowrap">
            <Star className="w-2.5 h-2.5 fill-[var(--success)]" /> выбрана
          </span>
        )}
      </div>
      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--ocean)] mt-auto">
        <Check className="w-3 h-3" /> участвует · вес {m.score}
      </span>
    </div>
  );
}

function ProviderCard({ p }: { p: Provider }) {
  return (
    <section className="ds-card">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10">
            <Cpu className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />
          </span>
          <div>
            <h2 className="font-playfair text-xl font-bold text-[var(--text-primary)]">{p.label}</h2>
            <p className="ds-label">{p.role}</p>
          </div>
        </div>
        {p.active && (
          <div className="text-right">
            <div className="ds-label">Активна сейчас</div>
            <div className="inline-flex items-center gap-1.5 mt-0.5">
              <span className="text-sm font-mono font-semibold text-[var(--accent)]">{p.active}</span>
              <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-hover)] px-1.5 py-0.5 rounded">
                {p.override ? 'override env' : 'авто'}
              </span>
            </div>
          </div>
        )}
      </div>

      {!p.has_key ? (
        <div className="flex items-center gap-2 text-sm text-[var(--warning)] bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded-lg p-3">
          <KeyRound className="w-4 h-4 flex-shrink-0" />
          Нет ключа или /v1/models недоступен — модели не получены. Резолвер использует безопасный алиас.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2.5 mb-4">
            <StatChip icon={Check} label="Годных" value={`${p.eligible_count} из ${p.total_count}`} />
            {p.override && <StatChip icon={KeyRound} label={p.override_env} value={p.override} />}
          </div>
          {p.pinned ? (
            // У флагмана нет списка кандидатов — вместо пустой сетки честно
            // объясняем, что id запинен и как проверить достижимость.
            <p className="text-sm text-[var(--text-secondary)] bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg p-3">
              {p.note}
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {p.models.map((m) => (
                <ModelTile key={m.id} m={m} active={m.id === p.active} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function ModelsClient() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/admin/evo/models');
      const json = (await res.json()) as { success: boolean; providers?: Provider[] };
      if (!json.success || !json.providers) { setError(true); return; }
      setProviders(json.providers);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-5xl lg:max-w-6xl mx-auto px-4 py-6 lg:py-8 space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">Модели эволюции</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Кто может принимать решения эволюции. Модель выбирается сама из <span className="font-mono">/v1/models</span> — без привязки к id.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ds-btn ds-btn-secondary inline-flex items-center gap-2 disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Обновить
        </button>
      </header>

      {loading && !providers ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : error ? (
        <div className="ds-card text-center py-14 text-[var(--text-secondary)]">
          Не удалось получить список моделей. Проверьте ключи провайдеров и доступность API.
        </div>
      ) : (
        (providers ?? []).map((p) => <ProviderCard key={p.key} p={p} />)
      )}
    </div>
  );
}
