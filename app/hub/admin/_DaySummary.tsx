'use client';

/**
 * «За сутки» на обзоре админки (слово владельца 22.10: «в главной админской
 * панели покажи числа: люди, MCP и A2A и кол-во взаимодействий с Кузьмичом за
 * сутки»). Четыре числа за камчатские сегодня и вчера; каждое — ссылка на
 * свою подробную страницу. Число, которое не прочиталось, так и названо:
 * «не загрузилось» вместо нуля (§4.0). Правила счёта — lib/analytics/day-summary.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Users, Plug, Network, MessageCircle, AlertTriangle, ArrowUpRight } from 'lucide-react';
import type { DaySummary, Metric } from '@/lib/analytics/day-summary-types';

const SURFACE_LABELS: Record<string, string> = {
  web: 'сайт', 'web-stream': 'сайт', telegram: 'Telegram', max: 'MAX', widget: 'виджет', a2a: 'A2A', other: 'прочее',
};

/** Ответы по поверхностям одной строкой: «сайт 5 · Telegram 3». Сайт и его потоковый вход — вместе. */
export function surfaceLine(by: Record<string, number>): string {
  const merged = new Map<string, number>();
  for (const [k, n] of Object.entries(by)) {
    const label = SURFACE_LABELS[k] ?? k;
    merged.set(label, (merged.get(label) ?? 0) + n);
  }
  return [...merged.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(' · ');
}

interface Tile {
  key: string;
  label: string;
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
  metric: Metric<unknown>;
  value: (m: Extract<Metric<unknown>, { ok: true }>) => { today: number; yesterday: number; sub: string };
}

function TileView({ t }: { t: Tile }) {
  const m = t.metric;
  const v = m.ok ? t.value(m) : null;
  return (
    <Link
      href={t.href}
      className="block p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] transition-colors"
    >
      <span className="flex items-center justify-between gap-1">
        <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <t.Icon className="w-3.5 h-3.5" /> {t.label}
        </span>
        <ArrowUpRight className="w-3 h-3 text-[var(--text-muted)]" aria-hidden />
      </span>
      {v ? (
        <>
          <span className="block text-2xl font-semibold text-[var(--text-primary)] mt-1 tabular-nums">{v.today}</span>
          <span className="block text-[11px] text-[var(--text-secondary)]">вчера {v.yesterday}</span>
          {v.sub && <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">{v.sub}</span>}
        </>
      ) : (
        <span className="flex items-center gap-1 text-xs text-[var(--text-secondary)] mt-2">
          <AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--warning)' }} /> не загрузилось
        </span>
      )}
    </Link>
  );
}

async function fetchSummary(): Promise<{ data: DaySummary } | { error: string }> {
  try {
    const res = await fetch('/api/admin/analytics/day-summary');
    const json = await res.json();
    if (!res.ok || !json.success) return { error: typeof json.error === 'string' ? json.error : 'Сводка суток не загрузилась' };
    return { data: json.data as DaySummary };
  } catch {
    return { error: 'Сводка суток не загрузилась — похоже, связь' };
  }
}

export default function DaySummaryStrip() {
  const [data, setData] = useState<DaySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (r: { data: DaySummary } | { error: string }) => {
    if ('data' in r) setData(r.data);
    else setError(r.error);
  };
  useEffect(() => {
    let alive = true;
    fetchSummary().then((r) => { if (alive) apply(r); });
    return () => { alive = false; };
  }, []);
  const load = () => {
    setError(null);
    setData(null);
    fetchSummary().then(apply);
  };

  if (error) {
    return (
      <section aria-label="За сутки" className="flex items-start gap-2 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
        <p className="text-xs text-[var(--text-secondary)]">{error}</p>
      </section>
    );
  }
  if (!data) return <div className="ds-skeleton h-24 rounded-lg" aria-label="За сутки: загрузка" />;

  const tiles: Tile[] = [
    {
      key: 'people', label: 'Люди', href: '/hub/admin/traffic', Icon: Users, metric: data.people,
      value: (m) => {
        const x = m as Extract<DaySummary['people'], { ok: true }>;
        return { today: x.today.visitors, yesterday: x.yesterday.visitors, sub: `просмотров ${x.today.views} · ботов ${x.today.bot_views}` };
      },
    },
    {
      key: 'mcp', label: 'MCP', href: '/hub/admin/mcp', Icon: Plug, metric: data.mcp,
      value: (m) => {
        const x = m as Extract<DaySummary['mcp'], { ok: true }>;
        return { today: x.today.calls, yesterday: x.yesterday.calls, sub: `вызовов · разных вызывающих ${x.today.callers}` };
      },
    },
    {
      key: 'a2a', label: 'A2A', href: '/hub/admin/a2a', Icon: Network, metric: data.a2a,
      value: (m) => {
        const x = m as Extract<DaySummary['a2a'], { ok: true }>;
        return { today: x.today.requests, yesterday: x.yesterday.requests, sub: `обращений · разных агентов ${x.today.callers}` };
      },
    },
    {
      key: 'kuzmich', label: 'Кузьмич', href: '/hub/admin/ai-usage?tab=kuzmich', Icon: MessageCircle, metric: data.kuzmich,
      value: (m) => {
        const x = m as Extract<DaySummary['kuzmich'], { ok: true }>;
        return { today: x.today.answers, yesterday: x.yesterday.answers, sub: surfaceLine(x.today.by_surface) || 'ответов' };
      },
    },
  ];

  return (
    <section aria-label="За сутки" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">За сутки по Камчатке</h2>
        <button type="button" onClick={load} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">обновить</button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((t) => <TileView key={t.key} t={t} />)}
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">
        Сегодня — с полуночи по Камчатке до этой минуты. Люди — разные посетители без ботов и ваших заходов; кто
        заходил и до, и после полудня, считается дважды (суточный отпечаток). MCP и A2A — без ваших вызовов и проверок,
        A2A без чтения визитки. Кузьмич — ответы на всех входах, ваши разговоры с ним в числе.
      </p>
    </section>
  );
}
