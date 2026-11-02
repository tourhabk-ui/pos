'use client';

/**
 * «Мессенджеры для заявок» — одна панель для экрана «Операторы» и формы
 * «Редактирование партнёра» (02.11). Показывает только «подключён / нет» и
 * названия карточек на общем чате; chat id и телефонов здесь нет. Ссылку
 * подключения выдаёт тот же POST /api/admin/operators/[id]/channel-link —
 * администратор пересылает её сам, панель ничего не отправляет.
 */
import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, Send } from 'lucide-react';
import { LeadDeliveryLine, type LeadDeliveryView } from '@/components/admin/LeadDeliveryLine';

interface Status {
  max: boolean;
  telegram: boolean;
  sharedWith: string[];
  cabinetOf: string | null;
}

interface Props {
  partnerId: string;
  /** Что уже известно из списка — показывается, пока не пришло состояние с сервера. */
  initialBound?: { telegram: boolean; max: boolean };
  lastDelivery?: LeadDeliveryView | null;
  title?: string;
}

export default function ChannelLinkPanel({ partnerId, initialBound, lastDelivery, title }: Props) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; message: string; expiresAt: string; bound: { telegram: boolean; max: boolean } }
    | { kind: 'error'; error: string }
  >({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  // Отдельно от state: сбой буфера обмена не должен стирать выданную ссылку
  // ровно тогда, когда просят выделить её вручную (обзор 29.09).
  const [copyError, setCopyError] = useState<string | null>(null);

  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState(false);

  // Состояние и общий чат — с сервера, по правилу доставки (reachForPartner).
  // Экран «Операторы» уже знает состояние из списка — там лишних запросов нет.
  const fetchStatus = initialBound === undefined;
  useEffect(() => {
    if (!fetchStatus) return;
    let alive = true;
    fetch(`/api/admin/operators/${partnerId}/channel-link`)
      .then(async (res) => {
        const json = await res.json().catch(() => null) as { success?: boolean; data?: Status } | null;
        if (!alive) return;
        if (res.ok && json?.success && json.data) setStatus(json.data);
        else setStatusError(true);
      })
      .catch(() => { if (alive) setStatusError(true); });
    return () => { alive = false; };
  }, [partnerId, fetchStatus]);

  const bound: { telegram: boolean; max: boolean } | null = state.kind === 'ready'
    ? state.bound
    : status ? { telegram: status.telegram, max: status.max } : initialBound ?? null;

  async function issue() {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/admin/operators/${partnerId}/channel-link`, { method: 'POST' });
      const body = await res.json().catch(() => null) as
        | { success: true; data: { message: string; expires_at: string; bound: { telegram: boolean; max: boolean } } }
        | { success: false; error?: string }
        | null;
      if (!res.ok || !body || !body.success) {
        setState({ kind: 'error', error: (body && !body.success && body.error) || `Сервер ответил ${res.status}` });
        return;
      }
      setState({ kind: 'ready', message: body.data.message, expiresAt: body.data.expires_at, bound: body.data.bound });
    } catch {
      setState({ kind: 'error', error: 'Нет связи с сервером' });
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('Не удалось скопировать — выделите текст в поле выше вручную.');
    }
  }

  const badge = (on: boolean, label: string) => (
    <span className={`text-xs px-2 py-0.5 rounded ${on
      ? 'bg-[var(--success)]/15 text-[var(--success)]'
      : 'bg-[var(--bg-hover)] text-[var(--text-muted)]'}`}>
      {label}: {on ? 'подключён' : 'нет'}
    </span>
  );

  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Send className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
        {title && <span className="text-xs font-medium text-[var(--text-primary)]">{title}</span>}
        {bound ? (
          <>
            {badge(bound.max, 'MAX')}
            {badge(bound.telegram, 'Telegram')}
          </>
        ) : statusError ? (
          <span className="text-xs text-[var(--text-muted)]">Состояние не прочитано</span>
        ) : (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" />
        )}
        <button
          onClick={issue}
          disabled={state.kind === 'loading'}
          className="ds-btn ds-btn-secondary text-xs px-2 py-1"
        >
          {state.kind === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Ссылка для подключения'}
        </button>
      </div>
      {lastDelivery !== undefined && <LeadDeliveryLine delivery={lastDelivery} />}
      {status && status.sharedWith.length > 0 && (
        <p className="text-xs text-[var(--text-secondary)]" data-testid="shared-chat-note">
          Чат общий с {status.sharedWith.map((n) => `«${n}»`).join(', ')}
          {status.cabinetOf
            ? `: кабинет в чате — «${status.cabinetOf}», заявки этой карточки тоже приходят туда.`
            : ': кабинет в чате — этой карточки, их заявки тоже приходят сюда.'}
        </p>
      )}
      {bound && !bound.max && !bound.telegram && state.kind === 'idle' && (
        <p className="text-xs text-[var(--warning)]">
          Заявки этому оператору сейчас не доходят: ни MAX, ни Telegram не подключены.
        </p>
      )}
      {state.kind === 'error' && <p className="text-xs text-[var(--danger)]">{state.error}</p>}
      {state.kind === 'ready' && (
        <div className="space-y-1.5">
          <p className="text-xs text-[var(--text-secondary)]">
            Перешлите оператору любым способом (WhatsApp, почта, SMS). Действует до{' '}
            {new Date(state.expiresAt).toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka' })} по Камчатке.
          </p>
          <textarea
            readOnly
            value={state.message}
            rows={6}
            className="ds-input w-full text-xs font-mono"
            onFocus={e => e.currentTarget.select()}
          />
          <button onClick={() => copy(state.message)} className="ds-btn ds-btn-secondary text-xs px-2 py-1 inline-flex items-center gap-1">
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Скопировано' : 'Скопировать текст'}
          </button>
          {copyError && <p className="text-xs text-[var(--danger)]" role="alert">{copyError}</p>}
        </div>
      )}
    </div>
  );
}

