'use client';

/**
 * Расширенная статистика визитов — открывается нажатием на «Визиты» в
 * «Воронке за период» (владелец 21.10: «круто бы при нажатии на количество
 * визитов открывалась бы расширенная статистика»). Окно то же, что у воронки.
 * Источник и страница входа — по первому просмотру человека в окне, поэтому
 * сумма строк равна числу визитов.
 */

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { internalHref } from '@/lib/analytics/traffic-links';
import { fmtKamchatka } from '@/lib/analytics/kamchatka-day';

interface Breakdown {
  window: { label: string; visitor_unit: 'people' | 'visitor_days'; partial: boolean };
  visits: number | null;
  sources: Array<{ group: string; label: string; visits: number; hosts: Array<{ host: string; visits: number }> }> | null;
  landing: Array<{ path: string; visits: number }> | null;
  devices: Array<{ device: string; visits: number }> | null;
  device_since: string | null;
  aside?: { bots: number; selfs: number; ai: number } | null;
  failed: Array<{ measure: string; error: string }>;
}

const DEVICE_LABEL: Record<string, string> = {
  mobile: 'Телефон', tablet: 'Планшет', desktop: 'Компьютер', unknown: 'Не записано',
};

function Bar({ label, n, total, sub }: { label: React.ReactNode; n: number; total: number; sub?: string }) {
  const pct = total > 0 ? Math.round((n / total) * 100) : 0;
  return (
    <div className="py-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">{label}</span>
        <span className="font-mono tabular-nums text-[var(--text-primary)]">{n.toLocaleString('ru-RU')}</span>
        <span className="font-mono tabular-nums text-[var(--text-muted)] w-9 text-right">{pct}%</span>
      </div>
      <div className="h-1 mt-1 rounded-full bg-[var(--bg-hover)] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--ocean)]/60" style={{ width: `${pct}%` }} />
      </div>
      {sub && <p className="text-[10px] text-[var(--text-muted)] mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

export default function VisitsBreakdown({ query, onClose }: { query: string; onClose: () => void }) {
  const [state, setState] = useState<{ q: string; data: Breakdown | null; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/analytics/visits-breakdown?${query}`)
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        setState(json.success
          ? { q: query, data: json.data as Breakdown, error: null }
          : { q: query, data: null, error: json.error ?? 'Не удалось прочитать визиты' });
      })
      .catch(() => { if (!cancelled) setState({ q: query, data: null, error: 'Не удалось прочитать визиты' }); });
    return () => { cancelled = true; };
  }, [query]);

  const d = state?.q === query ? state.data : null;
  const error = state?.q === query ? state.error : null;
  const total = d?.visits ?? 0;
  const devTotal = (d?.devices ?? []).reduce((s, x) => s + x.visits, 0);

  return (
    <section
      aria-label="Подробно о визитах"
      className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--bg-hover)]/40 backdrop-blur-sm p-3 space-y-3"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Визиты подробно</p>
          <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
            {d ? `${d.window.label} · ${d.visits === null ? 'нет данных' : d.visits.toLocaleString('ru-RU')}` : '…'}
          </p>
          {d && (
            <>
              <p className="text-[10px] text-[var(--text-muted)]">
                {d.aside
                  ? `боты: ${d.aside.bots.toLocaleString('ru-RU')}, свои: ${d.aside.selfs.toLocaleString('ru-RU')}`
                  : 'боты и свои: не сосчитано'}
              </p>
              <p className="text-[10px] text-[var(--text-muted)]">
                ИИ-краулеры: {d.aside ? d.aside.ai.toLocaleString('ru-RU') : 'не сосчитано'}
              </p>
            </>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Свернуть" className="p-1.5 -m-1 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">
          <X className="w-4 h-4" />
        </button>
      </div>

      {error ? (
        <p className="text-xs text-[var(--danger)]" role="alert">{error}</p>
      ) : !d ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-8 rounded-md bg-[var(--bg-hover)] animate-pulse" />)}</div>
      ) : (
        <>
          {d.failed.length > 0 && (
            <p className="text-[11px] text-[var(--warning)]">Не сосчитано: {d.failed.map((f) => f.measure).join(', ')}.</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Откуда пришли</p>
              {d.sources === null ? <p className="text-xs text-[var(--text-muted)]">нет данных</p>
                : d.sources.length === 0 ? <p className="text-xs text-[var(--text-muted)]">За период визитов нет.</p>
                : d.sources.map((s) => (
                  <Bar key={s.group} label={s.label} n={s.visits} total={total}
                    sub={s.hosts.length ? s.hosts.map((h) => `${h.host} ${h.visits}`).join(' · ') : undefined} />
                ))}
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Устройство</p>
              {d.devices === null ? <p className="text-xs text-[var(--text-muted)]">нет данных</p>
                : d.devices.map((x) => <Bar key={x.device} label={DEVICE_LABEL[x.device] ?? x.device} n={x.visits} total={devTotal} />)}
              <p className="text-[10px] text-[var(--text-muted)] mt-1">
                {d.device_since
                  ? `Устройство записывается с ${fmtKamchatka(d.device_since) ?? '—'} по Камчатке; более ранние визиты — «Не записано».`
                  : 'Устройство начнёт записываться с этого обновления; до него — «Не записано».'}
              </p>
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Страница входа</p>
            {d.landing === null ? <p className="text-xs text-[var(--text-muted)]">нет данных</p>
              : d.landing.map((l) => {
                const href = internalHref(l.path);
                const label = href
                  ? <a href={href} target="_blank" rel="noopener" className="font-mono hover:text-[var(--ocean)] hover:underline underline-offset-2" title={l.path}>{l.path}</a>
                  : <span className="font-mono" title={l.path}>{l.path}</span>;
                return <Bar key={l.path} label={label} n={l.visits} total={total} />;
              })}
          </div>

          <p className="text-[10px] text-[var(--text-muted)]">
            Источник и страница входа — по первому просмотру человека за период, поэтому строки складываются в число визитов.
            {d.window.visitor_unit === 'visitor_days' && ' На нескольких сутках визиты — человеко-дни.'}
            {' '}В число визитов входят только люди. Краулеры и ваши заходы — в строке над таблицей, не внутри неё. Старые строки по User-Agent не переклассифицированы: он в журнал не писался. Город и страна не хранятся.
            {' '}«Напрямую» — браузер не передал, откуда переход (закладка, ввод адреса, часть приложений).
          </p>
        </>
      )}
    </section>
  );
}
