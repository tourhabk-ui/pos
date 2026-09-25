'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Award, RefreshCw, CheckCircle, XCircle, AlertTriangle, ExternalLink, Clock, Loader2,
} from 'lucide-react';

/**
 * Проверка аттестатов гидов.
 *
 * Счётчики до загрузки — «…», при отказе — «—», а не нули: ноль здесь читается
 * как «проверять нечего». Ответ PATCH читается: не подтвердилось — видно.
 */

interface Cert {
  id: string;
  guide_name: string | null;
  guide_email: string | null;
  name: string;
  issuing_authority: string;
  issue_date: string | null;
  expiry_date: string | null;
  certificate_number: string | null;
  document_url: string | null;
  is_verified: boolean;
  source: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
}

interface Stats {
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  verified_unreviewed: number;
  expired: number;
  reattestation_needed: number | null;
  reattestation_unknown: number | null;
}

const SOURCE_LABEL: Record<string, string> = {
  import: 'импорт реестра',
  guide: 'внёс гид',
};

function fmt(d: string | null): string {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('ru-RU');
}

export default function AdminGuideCertifications() {
  const [certs, setCerts] = useState<Cert[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('pending');
  const [rejecting, setRejecting] = useState<{ id: string; comment: string } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/guide-certifications?filter=${filter}`);
      const json: unknown = await res.json().catch(() => null);
      const ok = res.ok && typeof json === 'object' && json !== null && (json as { success?: boolean }).success === true;
      if (!ok) {
        const msg = (json as { error?: string } | null)?.error;
        setLoadError(msg ?? `Не удалось загрузить аттестаты (HTTP ${res.status})`);
        setStats(null);
        setCerts([]);
        return;
      }
      const data = (json as { data: { items: Cert[]; stats: Stats } }).data;
      setCerts(data.items);
      setStats(data.stats);
    } catch {
      setLoadError('Сеть недоступна — аттестаты не загружены');
      setStats(null);
      setCerts([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const decide = async (id: string, verified: boolean, comment?: string) => {
    setActing(id);
    setActionError(null);
    try {
      const res = await fetch('/api/admin/guide-certifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, is_verified: verified, comment }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || (json as { success?: boolean } | null)?.success !== true) {
        setActionError((json as { error?: string } | null)?.error ?? `Решение не сохранено (HTTP ${res.status})`);
        return;
      }
      setRejecting(null);
      await fetchData();
    } catch {
      setActionError('Сеть недоступна — решение не сохранено');
    } finally {
      setActing(null);
    }
  };

  const shown = (n: number | null | undefined): string =>
    loading && !stats ? '…' : n == null ? '—' : String(n);

  const kpis = [
    { label: 'Ждут проверки', value: shown(stats?.pending), cls: 'text-[var(--warning)]' },
    { label: 'Подтверждено', value: shown(stats?.verified), cls: 'text-[var(--success)]' },
    { label: 'Из них без проверки человеком', value: shown(stats?.verified_unreviewed), cls: 'text-[var(--text-secondary)]' },
    { label: 'Отклонено', value: shown(stats?.rejected), cls: 'text-[var(--danger)]' },
    { label: 'Просрочено', value: shown(stats?.expired), cls: 'text-[var(--danger)]' },
    // Все аттестации гида до 01.07.2024 → переаттестация до 1 октября (реестр)
    { label: 'Нужна переаттестация', value: shown(stats?.reattestation_needed), cls: 'text-[var(--warning)]' },
    // Ни одной даты выдачи — платформа судить не может; не ноль, а «не знаем»
    { label: 'Переаттестация: не знаем (нет дат)', value: shown(stats?.reattestation_unknown), cls: 'text-[var(--text-secondary)]' },
    { label: 'Всего аттестатов', value: shown(stats?.total), cls: 'text-[var(--text-primary)]' },
  ];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Award className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Аттестаты гидов</h1>
        </div>
        <button
          onClick={() => void fetchData()}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Обновить
        </button>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-xs text-[var(--text-primary)]">
          <AlertTriangle className="w-4 h-4 text-[var(--danger)] flex-shrink-0" />
          <span>{loadError}</span>
        </div>
      )}
      {actionError && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-xs text-[var(--text-primary)]">
          <AlertTriangle className="w-4 h-4 text-[var(--danger)] flex-shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpis.map(kpi => (
          <div key={kpi.label} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1">{kpi.label}</p>
            <span className={`text-xl font-semibold font-mono ${kpi.cls}`}>{kpi.value}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {[
          { v: 'pending', l: 'Ждут проверки' },
          { v: 'rejected', l: 'Отклонены' },
          { v: 'true', l: 'Подтверждены' },
          { v: 'all', l: 'Все' },
        ].map(opt => (
          <button
            key={opt.v}
            onClick={() => setFilter(opt.v)}
            className={`px-2.5 py-1 text-[10px] font-medium rounded-md border transition-colors ${
              filter === opt.v
                ? 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/30'
                : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border-[var(--border)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            {opt.l}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg animate-pulse" />
          ))}
        </div>
      ) : loadError ? null : certs.length === 0 ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-12 text-center">
          <Award className="w-6 h-6 text-[var(--text-muted)] mx-auto mb-2" />
          <p className="text-xs text-[var(--text-muted)]">По этому фильтру аттестатов нет</p>
        </div>
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th className="px-4 py-2.5 text-left font-medium">Гид</th>
                <th className="py-2.5 text-left font-medium">Аттестат</th>
                <th className="py-2.5 text-left font-medium hidden lg:table-cell">Кем выдан</th>
                <th className="py-2.5 text-left font-medium hidden md:table-cell">Выдан / до</th>
                <th className="py-2.5 text-left font-medium">Статус</th>
                <th className="py-2.5 text-right font-medium pr-4">Решение</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {certs.map(cert => {
                const expired = cert.expiry_date ? cert.expiry_date < new Date().toISOString().slice(0, 10) : false;
                const pending = !cert.is_verified && !cert.reviewed_at;
                return (
                  <tr key={cert.id} className="hover:bg-[var(--bg-hover)] transition-colors align-top">
                    <td className="px-4 py-3">
                      <p className="text-[var(--text-primary)] font-medium truncate max-w-[160px]">{cert.guide_name ?? 'имя не записано'}</p>
                      <p className="text-[10px] text-[var(--text-muted)]">{cert.guide_email ?? 'без аккаунта'}</p>
                    </td>
                    <td className="py-3">
                      <p className="text-[var(--text-primary)] truncate max-w-[180px]">{cert.name}</p>
                      <p className="text-[10px] text-[var(--text-muted)] font-mono">
                        {cert.certificate_number ? `№ ${cert.certificate_number}` : 'номер не записан'}
                        {' · '}{cert.source ? SOURCE_LABEL[cert.source] ?? cert.source : 'источник не записан'}
                      </p>
                    </td>
                    <td className="py-3 text-[var(--text-secondary)] hidden lg:table-cell truncate max-w-[140px]">
                      {cert.issuing_authority}
                    </td>
                    <td className="py-3 hidden md:table-cell">
                      <span className={`text-[10px] font-mono ${expired ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
                        {cert.issue_date ? fmt(cert.issue_date) : 'дата выдачи не записана'}
                        {cert.expiry_date ? ` — ${fmt(cert.expiry_date)}` : ''}
                      </span>
                      {expired && <AlertTriangle className="inline w-3 h-3 ml-1 text-[var(--danger)]" />}
                    </td>
                    <td className="py-3">
                      {cert.is_verified ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-[var(--success)]/10 text-[var(--success)]">
                          <CheckCircle className="w-2.5 h-2.5" /> {cert.reviewed_at ? 'Подтверждён' : 'Подтверждён без проверки'}
                        </span>
                      ) : pending ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-[var(--warning)]/10 text-[var(--warning)]">
                          <Clock className="w-2.5 h-2.5" /> Ждёт проверки
                        </span>
                      ) : (
                        <span className="inline-flex flex-col gap-0.5">
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-[var(--danger)]/10 text-[var(--danger)]">
                            <XCircle className="w-2.5 h-2.5" /> Отклонён
                          </span>
                          {cert.review_comment && (
                            <span className="text-[10px] text-[var(--text-muted)] max-w-[160px]">{cert.review_comment}</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-right pr-4">
                      {rejecting?.id === cert.id ? (
                        <div className="flex flex-col items-end gap-1.5">
                          <textarea
                            value={rejecting.comment}
                            onChange={(e) => setRejecting({ id: cert.id, comment: e.target.value })}
                            placeholder="Причина — её увидит гид"
                            rows={2}
                            className="w-48 px-2 py-1 text-[11px] bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                          />
                          <div className="flex gap-1.5">
                            <button onClick={() => setRejecting(null)} className="px-2 py-1 text-[10px] text-[var(--text-secondary)]">Отмена</button>
                            <button
                              onClick={() => void decide(cert.id, false, rejecting.comment)}
                              disabled={acting === cert.id}
                              className="px-2 py-1 text-[10px] rounded-md bg-[var(--danger)] text-white disabled:opacity-50"
                            >
                              Отклонить
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 justify-end">
                          {cert.document_url && (
                            <a
                              href={cert.document_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1 text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                              title="Открыть документ"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                          {acting === cert.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" />}
                          {!(cert.is_verified && cert.reviewed_at) && (
                            <button
                              onClick={() => void decide(cert.id, true)}
                              disabled={acting === cert.id}
                              className="p-1 text-[var(--text-muted)] hover:text-[var(--success)] transition-colors disabled:opacity-50"
                              title="Подтвердить"
                            >
                              <CheckCircle className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {(cert.is_verified || pending) && (
                            <button
                              onClick={() => setRejecting({ id: cert.id, comment: '' })}
                              disabled={acting === cert.id}
                              className="p-1 text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors disabled:opacity-50"
                              title="Отклонить"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
