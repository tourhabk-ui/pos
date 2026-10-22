'use client';

/**
 * Расшифровка числа со страницы «Запросы через MCP» (слово владельца 22.10:
 * «нужна расшифровка по дням mcp кто звал чем интересовался при нажатии на
 * информационные кнопки с числами»).
 *
 * По суткам: какая программа звала, сколько раз, сколькими разными
 * вызывающими, какими инструментами и о чём спрашивала. «О чём» — главный
 * аргумент вызова, который пишет журнал (lib/mcp/call-reason): у читающих
 * инструментов — значение до 40 знаков, у пишущих — ничего. Чего журнал не
 * знает, расшифровка так и говорит.
 */

import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Breakdown, BreakdownOrigin, BreakdownOutcome, ClientDay } from '@/lib/mcp/day-breakdown-types';

export interface BreakdownRequest {
  origin: BreakdownOrigin;
  outcome?: BreakdownOutcome;
  days: number;
  skip?: number;
}

const ORIGIN_WORD: Record<ClientDay['origin'], string> = { external: 'внешний', self: 'свой', probe: 'проверка' };

export function breakdownUrl(q: BreakdownRequest): string {
  const p = new URLSearchParams({
    origin: q.origin,
    outcome: q.outcome ?? 'all',
    days: String(q.days),
    skip: String(q.skip ?? 0),
  });
  return `/api/admin/analytics/mcp/breakdown?${p.toString()}`;
}

function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function ClientBlock({ c, showOrigin }: { c: ClientDay; showOrigin: boolean }) {
  const asked = c.topics.filter((t) => t.value !== null && t.value !== '');
  return (
    <li className="py-2.5 border-t border-[var(--border)] first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-[var(--text-primary)] break-all">{c.client}</span>
        {c.kind !== 'представился' && <span className="text-[10px] text-[var(--text-muted)]">{c.kind === 'по заголовку' ? 'имя по заголовку' : 'не представился'}</span>}
        {showOrigin && <span className="ds-badge text-[10px]">{ORIGIN_WORD[c.origin]}</span>}
        {c.region && <span className="ds-badge text-[10px]">{c.region}</span>}
        <span className="text-xs text-[var(--text-secondary)] ml-auto tabular-nums">
          {c.calls} {plural(c.calls, 'вызов', 'вызова', 'вызовов')} · разных вызывающих {c.callers}
        </span>
      </div>
      {(c.failures > 0 || c.refusals > 0) && (
        <p className="text-[11px] text-[var(--text-muted)] mt-0.5">сбоев {c.failures} · отказов {c.refusals}</p>
      )}
      <p className="text-xs text-[var(--text-secondary)] mt-1">
        <span className="text-[var(--text-muted)]">Инструменты: </span>
        {c.tools.map((t, i) => (
          <span key={t.tool}>{i > 0 && ' · '}<code>{t.tool}</code> {t.calls}</span>
        ))}
      </p>
      {asked.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {asked.map((t) => (
            <li key={`${t.tool}|${t.key}|${t.value}`} className="text-xs text-[var(--text-primary)]">
              {t.value} <span className="text-[var(--text-muted)]">— {t.tool}{t.key ? `, ${t.key}` : ''} ×{t.n}</span>
            </li>
          ))}
          {c.topics_more > 0 && <li className="text-[11px] text-[var(--text-muted)]">и ещё тем: {c.topics_more}</li>}
        </ul>
      ) : (
        <p className="text-[11px] text-[var(--text-muted)] mt-0.5">О чём спрашивали — не записано: у этих вызовов журнал хранит только имя инструмента.</p>
      )}
    </li>
  );
}

export default function McpDayBreakdown({ id, title, request }: { id: string; title: string; request: BreakdownRequest }) {
  const [data, setData] = useState<Breakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const url = breakdownUrl(request);

  // Состояние начальное у каждого числа своё: родитель монтирует расшифровку
  // заново на каждое число (key), поэтому сбрасывать его здесь не нужно.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(url);
        const json = await res.json();
        if (!alive) return;
        if (!res.ok || !json.success) setError(typeof json.error === 'string' ? json.error : 'Не удалось построить расшифровку');
        else setData(json.data as Breakdown);
      } catch {
        if (alive) setError('Расшифровка не загрузилась — похоже, связь');
      }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [url]);

  const showOrigin = request.origin === 'own';
  const range = data ? (data.from === data.to ? fmtDay(data.from) : `${fmtDay(data.from)} — ${fmtDay(data.to)}`) : '';

  return (
    <section id={id} aria-label={`${title}: расшифровка`} className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold text-[var(--text-secondary)]">{title}: кто звал и о чём</h2>
        {range && <span className="text-[11px] text-[var(--text-muted)]">{range}, сутки по Камчатке</span>}
      </div>
      {loading && <div className="ds-skeleton h-16 rounded-lg mt-2" />}
      {error && (
        <div className="flex items-start gap-2 mt-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
          <p className="text-xs text-[var(--text-secondary)]">{error}</p>
        </div>
      )}
      {data && !loading && (
        data.days.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] mt-2">За эти сутки таких вызовов нет.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {data.days.map((d, i) => (
              <details key={d.day} open={i === 0} className="rounded-md border border-[var(--border)]">
                <summary className="cursor-pointer px-2.5 py-2 text-xs text-[var(--text-primary)]">
                  <span className="font-semibold">{fmtDay(d.day)}</span>
                  {' · '}{d.calls} {plural(d.calls, 'вызов', 'вызова', 'вызовов')}
                  {' · '}разных вызывающих {d.callers}
                  {' · '}{d.clients.length} {plural(d.clients.length, 'программа', 'программы', 'программ')}
                </summary>
                <ul className="px-2.5 pb-1">
                  {d.clients.map((c) => (
                    <ClientBlock key={`${c.client}|${c.kind}|${c.origin}`} c={c} showOrigin={showOrigin} />
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )
      )}
      <p className="text-[10px] text-[var(--text-muted)] mt-2">
        Имя — то, которым программа представилась при подключении: это программа, не человек. «Разных
        вызывающих» — по суточному отпечатку; кто звал и до, и после полудня по Камчатке, считается дважды.
        «О чём» — главный параметр вызова у читающих инструментов (до 40 знаков, телефон и почта скрыты).
      </p>
    </section>
  );
}
