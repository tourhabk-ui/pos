'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, HelpCircle, Clock, ExternalLink, RefreshCw } from 'lucide-react';

/**
 * Отчёты внешней проверки сайтов операторов.
 *
 * Экран строится вокруг одного правила: «не смогли проверить» — не «хорошо».
 * Непроверенное и недоступное видно отдельным состоянием, а не отсутствием
 * замечаний; иначе оператор с мёртвым сайтом выглядел бы благополучным ровно
 * так же, как оператор с исправным.
 */

interface Check {
  id: string;
  outcome: 'ok' | 'bad' | 'unknown';
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

interface Item {
  partnerId: string;
  name: string;
  siteUrl: string | null;
  consent: string;
  checkedAt: string | null;
  verdict: 'ok' | 'issues' | 'unknown' | 'never';
  checks: Check[];
  badCount: number;
  unknownCount: number;
  failure: string | null;
}

interface Payload {
  total: number;
  summary: { issues: number; unknown: number; never: number; ok: number };
  items: Item[];
}

const VERDICT_RU: Record<Item['verdict'], string> = {
  issues: 'есть замечания',
  unknown: 'проверить не смогли',
  never: 'ни разу не проверяли',
  ok: 'замечаний нет',
};

function VerdictBadge({ v }: { v: Item['verdict'] }) {
  const map = {
    issues: { cls: 'text-[var(--danger)] border-[var(--danger)]', Icon: ShieldAlert },
    unknown: { cls: 'text-[var(--warning)] border-[var(--warning)]', Icon: HelpCircle },
    never: { cls: 'text-[var(--text-muted)] border-[var(--border)]', Icon: Clock },
    ok: { cls: 'text-[var(--success)] border-[var(--success)]', Icon: ShieldCheck },
  }[v];
  const { Icon } = map;
  return (
    <span className={`ds-badge inline-flex items-center gap-1.5 border ${map.cls}`}>
      <Icon className="w-3.5 h-3.5" aria-hidden />
      {VERDICT_RU[v]}
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function OperatorSitesClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/operator-sites', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as Payload);
    } catch (e) {
      // Отказ загрузки называется отказом, а не пустым списком.
      setError(e instanceof Error ? e.message : 'Не удалось загрузить отчёты');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  return (
    <div className="ds-page">
      <div className="ds-section">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="ds-h1">Сайты операторов</h1>
            <p className="text-[var(--text-secondary)] mt-2 max-w-2xl">
              Внешняя проверка: сертификат, HTTPS, заголовки безопасности, смешанный контент,
              раскрытие версий, открытые служебные файлы. Проверяется только то, что видит
              обычный посетитель — без перебора и эксплуатации.
            </p>
          </div>
          <button type="button" onClick={() => void load()} className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
            <RefreshCw className="w-4 h-4" aria-hidden />
            Обновить
          </button>
        </div>
      </div>

      {loading && (
        <div className="ds-section grid gap-3">
          {[0, 1, 2].map((i) => <div key={i} className="ds-skeleton h-16 rounded-lg" />)}
        </div>
      )}

      {error && (
        <div className="ds-section">
          <div className="ds-card border-[var(--danger)]">
            <h2 className="ds-h2 text-[var(--danger)]">Отчёты не загрузились</h2>
            <p className="text-[var(--text-secondary)] mt-2">{error}</p>
            <p className="text-[var(--text-muted)] mt-2 text-sm">
              Это отказ загрузки, а не отсутствие замечаний: состояние сайтов сейчас неизвестно.
            </p>
          </div>
        </div>
      )}

      {data && !loading && !error && (
        <>
          <div className="ds-section grid grid-cols-2 md:grid-cols-4 gap-3">
            {([
              ['Есть замечания', data.summary.issues, 'text-[var(--danger)]'],
              ['Проверить не смогли', data.summary.unknown, 'text-[var(--warning)]'],
              ['Ни разу не проверяли', data.summary.never, 'text-[var(--text-muted)]'],
              ['Замечаний нет', data.summary.ok, 'text-[var(--success)]'],
            ] as Array<[string, number, string]>).map(([label, n, cls]) => (
              <div key={label} className="ds-card">
                <div className={`text-3xl font-bold ${cls}`}>{n}</div>
                <div className="ds-label mt-1">{label}</div>
              </div>
            ))}
          </div>

          <div className="ds-section grid gap-3">
            {data.items.length === 0 && (
              <div className="ds-card">
                <p className="text-[var(--text-secondary)]">
                  Ни у одного оператора не указан сайт. Проверять нечего — и это не то же самое,
                  что «все сайты в порядке».
                </p>
              </div>
            )}

            {data.items.map((it) => (
              <div key={it.partnerId} className="ds-card">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-[var(--text-primary)]">{it.name}</h3>
                    {it.siteUrl && (
                      <a
                        href={it.siteUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-sm text-[var(--ocean)] inline-flex items-center gap-1 mt-1 break-all"
                      >
                        {it.siteUrl}
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden />
                      </a>
                    )}
                    <div className="text-sm text-[var(--text-muted)] mt-1">
                      проверено: {formatDate(it.checkedAt)}
                      {it.consent === 'declined' && ' · оператор отказался от проверки'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <VerdictBadge v={it.verdict} />
                    {it.checks.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setOpen(open === it.partnerId ? null : it.partnerId)}
                        className="ds-btn ds-btn-secondary text-sm"
                      >
                        {open === it.partnerId ? 'Свернуть' : 'Подробно'}
                      </button>
                    )}
                  </div>
                </div>

                {it.failure && (
                  <p className="mt-3 text-sm text-[var(--warning)]">{it.failure}</p>
                )}

                {(it.badCount > 0 || it.unknownCount > 0) && (
                  <div className="mt-2 text-sm text-[var(--text-secondary)]">
                    замечаний: {it.badCount} · не проверено: {it.unknownCount}
                  </div>
                )}

                {open === it.partnerId && (
                  <ul className="mt-4 grid gap-2 border-t border-[var(--border)] pt-4">
                    {it.checks.map((c) => (
                      <li key={c.id} className="flex items-start gap-2 text-sm">
                        <span
                          className={
                            c.outcome === 'bad' ? 'text-[var(--danger)]'
                              : c.outcome === 'unknown' ? 'text-[var(--warning)]'
                                : 'text-[var(--success)]'
                          }
                        >
                          {c.outcome === 'bad' ? 'плохо' : c.outcome === 'unknown' ? 'не знаю' : 'хорошо'}
                        </span>
                        <span className="text-[var(--text-secondary)]">{c.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
