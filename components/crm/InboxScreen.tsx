'use client';

/**
 * «Входящие» — экран CRM кабинета партнёра (CRM 1г, #2325). Что ждёт ответа,
 * сколько ждёт и где на это ответить; сверху — медиана первого ответа за 7
 * дней (урок Tripster: заказы получает тот, кто ответил за два часа).
 *
 * Состояния не смешиваются (§4.0): «всё отвечено» говорится, только когда все
 * виды прочитались; не прочитался вид — так и сказано; медиана по трём
 * случаям не показывается числом — «мало данных».
 */
import { useEffect, useState } from 'react';
import { Inbox, Clock, ArrowUpRight, MessageSquare, AlertTriangle } from 'lucide-react';
import type { Inbox as InboxData, InboxItem } from '@/lib/crm/inbox';
import { INBOX_ACTION, INBOX_KIND_LABELS, INBOX_SLOW_MINUTES, RESPONSE_MIN_SAMPLE } from '@/lib/crm/inbox-kinds';
import { CRM_INBOX_API } from './api';
import { formatSourceDate } from './labels';
import { ContactPanel } from './ContactPanel';
import { SeatRequestActions } from './SeatRequestActions';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: InboxData }
  | { kind: 'error'; message: string; retry: boolean };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readInbox(json: unknown): InboxData | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  const d = json.data;
  return Array.isArray(d.items) && Array.isArray(d.failed) && isRecord(d.response) && isRecord(d.chat)
    ? (d as unknown as InboxData)
    : null;
}

/** «45 мин», «3 ч 10 мин», «2 дн 4 ч» — сколько ждёт или как быстро ответили. */
export function formatWait(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} дн ${h % 24} ч` : `${d} дн`;
}

function ResponseLine({ data }: { data: InboxData }) {
  const r = data.response;
  if (r.enough && r.median_minutes !== null) {
    return (
      <p className="text-xs text-[var(--text-secondary)]">
        Медиана первого ответа за {r.window_days} дней: <span className="font-semibold text-[var(--text-primary)]">{formatWait(r.median_minutes)}</span>
        {' '}— по {r.responded} обращениям{r.complete ? '' : ', часть видов не прочиталась'}.
      </p>
    );
  }
  return (
    <p className="text-xs text-[var(--text-muted)]">
      Время первого ответа: мало данных — за {r.window_days} дней ответов {r.responded}, медиану считаем от {RESPONSE_MIN_SAMPLE}.
    </p>
  );
}

function ItemRow({ item, onOpenContact, onAnswered }: { item: InboxItem; onOpenContact: (id: string) => void; onAnswered: () => void }) {
  const action = INBOX_ACTION[item.kind];
  const slow = item.waiting_minutes >= INBOX_SLOW_MINUTES;
  const date = formatSourceDate(item.date);
  return (
    <li className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-1.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs text-[var(--text-muted)]">{INBOX_KIND_LABELS[item.kind]}</p>
          <p className="text-sm font-semibold text-[var(--text-primary)]">{item.title ?? 'Без названия'}</p>
          <p className="text-xs text-[var(--text-secondary)]">
            {[date, item.people !== null && `${item.people} чел.`].filter(Boolean).join(' · ')}
            {item.contact_id && (
              <>
                {(date || item.people !== null) && ' · '}
                <button
                  type="button"
                  onClick={() => onOpenContact(item.contact_id as string)}
                  className="text-[var(--ocean)] hover:underline"
                >
                  {item.contact_name ?? 'Клиент без имени'}
                </button>
              </>
            )}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1 text-xs shrink-0 ${slow ? 'text-[var(--danger)] font-semibold' : 'text-[var(--text-muted)]'}`}
          title={slow ? 'Ждёт дольше двух часов' : undefined}
        >
          <Clock className="w-3.5 h-3.5" /> ждёт {formatWait(item.waiting_minutes)}
        </span>
      </div>
      {action.href ? (
        <a href={action.href} className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">
          {action.hint} <ArrowUpRight className="w-3 h-3" />
        </a>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">{action.hint}</p>
      )}
      {item.kind === 'seat_request' && <SeatRequestActions requestId={item.id} onAnswered={onAnswered} />}
    </li>
  );
}

export function InboxScreen() {
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: number; state: LoadState } | null>(null);
  const state: LoadState = result?.key === reload ? result.state : { kind: 'loading' };
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const done = (next: LoadState) => { if (!ctrl.signal.aborted) setResult({ key: reload, state: next }); };
    fetch(CRM_INBOX_API, { signal: ctrl.signal })
      .then(async (res) => {
        const json: unknown = await res.json().catch(() => null);
        const data = res.ok ? readInbox(json) : null;
        if (data) done({ kind: 'ready', data });
        else if (res.status === 401 || res.status === 403) {
          done({ kind: 'error', message: isRecord(json) && typeof json.error === 'string' ? json.error : 'Раздел доступен партнёрам платформы', retry: false });
        } else {
          done({ kind: 'error', message: isRecord(json) && typeof json.error === 'string' ? json.error : 'Не удалось загрузить входящие, попробуйте позже', retry: true });
        }
      })
      .catch(() => done({ kind: 'error', message: 'Нет связи с сервером — входящие не загружены', retry: true }));
    return () => ctrl.abort();
  }, [reload]);

  const refresh = () => setReload((n) => n + 1);

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <Inbox className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Входящие</h1>
        {state.kind === 'ready' && (
          <span className="text-xs text-[var(--text-muted)]">ждут ответа: {state.data.items.length}</span>
        )}
      </div>

      {state.kind === 'loading' && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="ds-skeleton h-20 rounded-lg" />)}
        </div>
      )}

      {state.kind === 'error' && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 text-center space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">{state.message}</p>
          {state.retry && <button type="button" onClick={refresh} className="ds-btn ds-btn-secondary">Повторить</button>}
        </div>
      )}

      {state.kind === 'ready' && (
        <>
          <ResponseLine data={state.data} />

          {state.data.failed.length > 0 && (
            <p role="alert" className="flex items-start gap-2 text-xs text-[var(--warning)]">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Не прочитались: {state.data.failed.map((k) => INBOX_KIND_LABELS[k]).join(', ')} — их здесь может не хватать.
              <button type="button" onClick={refresh} className="underline">Повторить</button>
            </p>
          )}

          {state.data.chat.state === 'ok' && state.data.chat.unread > 0 && (
            <p className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <MessageSquare className="w-4 h-4 text-[var(--ocean)]" />
              Непрочитанных сообщений в чате: {state.data.chat.unread} — чат открывается кнопкой внизу экрана.
            </p>
          )}
          {state.data.chat.state === 'failed' && (
            <p className="text-xs text-[var(--warning)]">Непрочитанные сообщения чата не посчитались.</p>
          )}

          {state.data.items.length === 0 ? (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
              <p className="text-sm text-[var(--text-primary)]">
                {state.data.failed.length > 0 ? 'В прочитанном ничего не ждёт ответа' : 'Ничего не ждёт ответа'}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {state.data.items.map((it) => (
                <ItemRow key={`${it.kind}:${it.id}`} item={it} onOpenContact={setOpenId} onAnswered={refresh} />
              ))}
            </ul>
          )}

          {state.data.not_here.length > 0 && (
            <div className="space-y-1">
              <p className="ds-label">Чего здесь нет</p>
              <ul className="space-y-1">
                {state.data.not_here.map((t) => <li key={t} className="text-xs text-[var(--text-muted)]">{t}</li>)}
              </ul>
            </div>
          )}
        </>
      )}

      {openId && <ContactPanel contactId={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </div>
  );
}
