'use client';

/**
 * Чек-лист готовности партнёра принимать заявки (план готовности 23.11,
 * этап 3c). Одна карточка на все кабинеты: оператор, гид, жильё, снаряжение,
 * перевозчик, прокат автомобилей.
 *
 * Правило и слова пунктов — lib/partners/readiness.ts; карточка их только
 * показывает. Состояние пункта названо словом, а не одним цветом.
 *
 * Три исхода чтения (§4.0): пункты пришли / чек-листа у роли нет (агент) /
 * не загрузился. Третий говорит об этом строкой, а не молчит.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, Clock, HelpCircle } from 'lucide-react';
import type { ItemState, PartnerReadiness, ReadinessItem } from '@/lib/partners/readiness';

type Load =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'none' }
  | { kind: 'ok'; data: PartnerReadiness };

const STATES: readonly ItemState[] = ['done', 'todo', 'waiting', 'unknown'];

function isItem(v: unknown): v is ReadinessItem {
  if (!v || typeof v !== 'object') return false;
  const i = v as Record<string, unknown>;
  return typeof i.key === 'string' && typeof i.title === 'string' && typeof i.detail === 'string'
    && typeof i.required === 'boolean' && STATES.includes(i.state as ItemState);
}

/** Ответ роута: пункты, «чек-листа нет» (null) или не то, что ждали. */
function readResponse(body: unknown): Load {
  if (!body || typeof body !== 'object' || (body as { success?: unknown }).success !== true) return { kind: 'failed' };
  const data = (body as { data?: unknown }).data;
  if (data === null) return { kind: 'none' };
  if (!data || typeof data !== 'object') return { kind: 'failed' };
  const d = data as Record<string, unknown>;
  if (typeof d.headline !== 'string' || !Array.isArray(d.items) || !d.items.every(isItem)) return { kind: 'failed' };
  if (d.verdict !== 'ready' && d.verdict !== 'not_ready' && d.verdict !== 'unknown') return { kind: 'failed' };
  return { kind: 'ok', data: data as PartnerReadiness };
}

const STATE_VIEW: Record<ItemState, { label: string; color: string; Icon: typeof CheckCircle2 }> = {
  done:    { label: 'Готово',        color: 'text-[var(--success)]',    Icon: CheckCircle2 },
  todo:    { label: 'За вами',       color: 'text-[var(--accent)]',     Icon: CircleDashed },
  waiting: { label: 'Ждёт не вас',   color: 'text-[var(--text-muted)]', Icon: Clock },
  unknown: { label: 'Не проверено',  color: 'text-[var(--warning)]',    Icon: HelpCircle },
};

function Item({ item, urgent }: { item: ReadinessItem; urgent: boolean }) {
  const view = STATE_VIEW[item.state];
  // Канал при карточке на витрине — тревога: цвет опасности, не акцента.
  const color = urgent && item.key === 'channel' ? 'text-[var(--danger)]' : view.color;
  return (
    <li className="flex items-start gap-3 py-3" data-state={item.state} data-key={item.key}>
      <view.Icon className={`w-4 h-4 mt-0.5 shrink-0 ${color}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--text-primary)]">
          {item.title}
          <span className={`ml-2 text-xs font-normal ${color}`}>{view.label}</span>
          {!item.required && <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">не обязательно</span>}
        </p>
        <p className="mt-0.5 text-sm text-[var(--text-secondary)] break-words">{item.detail}</p>
      </div>
      {item.href && (item.state === 'todo' || item.key === 'offer') && (
        <Link
          href={item.href}
          className="shrink-0 inline-flex items-center gap-1 min-h-[44px] px-2 text-sm text-[var(--ocean)] hover:underline transition-colors duration-200"
        >
          {item.key === 'offer' ? 'Читать' : 'Перейти'}
          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </Link>
      )}
    </li>
  );
}

export function PartnerReadinessCard() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/hub/partner/readiness', { signal: ctrl.signal })
      .then(async (res) => {
        if (ctrl.signal.aborted) return;
        // 403 — вход не партнёра (администратор смотрит кабинет): чек-листа нет.
        if (res.status === 403) { setLoad({ kind: 'none' }); return; }
        setLoad(res.ok ? readResponse(await res.json().catch(() => null)) : { kind: 'failed' });
      })
      .catch(() => { if (!ctrl.signal.aborted) setLoad({ kind: 'failed' }); });
    return () => ctrl.abort();
  }, []);

  if (load.kind === 'none') return null;
  if (load.kind === 'loading') {
    // Без role="status": на экранах кабинетов эта роль занята итогом действия
    // («ответ записан»), и вторая «живая» область спорила бы с ним.
    return <div className="ds-skeleton h-24 rounded-lg" aria-hidden="true" />;
  }
  if (load.kind === 'failed') {
    return (
      <p className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--text-secondary)]">
        Чек-лист готовности к заявкам не загрузился. Обновите страницу позже.
      </p>
    );
  }

  const { data } = load;
  const ready = data.verdict === 'ready';
  const edge = data.urgent ? 'border-[var(--danger)]' : ready ? 'border-[var(--success)]' : 'border-[var(--border)]';
  const HeadIcon = data.urgent ? AlertTriangle : ready ? CheckCircle2 : data.verdict === 'unknown' ? HelpCircle : CircleDashed;
  const headColor = data.urgent ? 'text-[var(--danger)]' : ready ? 'text-[var(--success)]' : 'text-[var(--text-muted)]';
  const list = (
    <ul className="divide-y divide-[var(--border)]">
      {data.items.map((item) => <Item key={item.key} item={item} urgent={data.urgent} />)}
    </ul>
  );

  return (
    <section
      aria-labelledby="partner-readiness-title"
      data-verdict={data.verdict}
      className={`rounded-lg border bg-[var(--bg-card)] px-4 py-3 ${edge}`}
    >
      <div className="flex items-start gap-3" role={data.urgent ? 'alert' : undefined}>
        <HeadIcon className={`w-5 h-5 mt-0.5 shrink-0 ${headColor}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-xs text-[var(--text-muted)]">Готовность к заявкам</p>
          <h2 id="partner-readiness-title" className="text-base font-semibold text-[var(--text-primary)] break-words">
            {data.headline}
          </h2>
        </div>
      </div>
      {/* Готовому партнёру пункты не нужны каждый день: они свёрнуты, но не спрятаны. */}
      {ready ? (
        <details className="mt-2">
          <summary className="min-h-[44px] inline-flex items-center cursor-pointer text-sm text-[var(--ocean)]">
            Показать пункты
          </summary>
          {list}
        </details>
      ) : (
        <div className="mt-2">{list}</div>
      )}
    </section>
  );
}
