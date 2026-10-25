'use client';
/**
 * «Подключите MAX» для МЕНЕДЖЕРА команды оператора (CRM 2г-4).
 *
 * Чат кабинета подключает владелец (PartnerChannelBanner). Менеджер получает
 * копии новых броней, заявок и запросов мест в СВОЙ мессенджер — ссылкой на
 * его строку команды (`/api/hub/operator/me/messenger`, срок сутки). Правило
 * «подключён» — то же, по которому шлёт рассылка команде
 * (lib/operators/team-notify): адрес в строке активного менеджера.
 *
 * Два состояния, как у баннера кабинета:
 *  - нет ни MAX, ни Telegram — о новой работе менеджер узнает, только открыв
 *    кабинет;
 *  - есть только Telegram — придёт без имён и телефонов: ПД туристов уходят
 *    только в MAX (решение владельца 23.08, lib/notifications/pd-alert).
 *
 * Сбой проверки — баннера нет: «не подключено» на сбое соврало бы (§4.0).
 */
import { useEffect, useState } from 'react';
import { BellOff, ExternalLink, MessageCircle, X } from 'lucide-react';
import { isPlaqueDismissed, rememberPlaqueDismissed, type ChannelPlaque } from '@/lib/hub/plaque-dismiss';

interface MemberChannel {
  max: boolean;
  telegram: boolean;
}

interface Links {
  max: string;
  telegram: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function readMemberChannel(json: unknown): MemberChannel | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  const d = json.data;
  if (d.kind !== 'manager') return null;
  return typeof d.max === 'boolean' && typeof d.telegram === 'boolean' ? { max: d.max, telegram: d.telegram } : null;
}

function readLinks(json: unknown): Links | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  const d = json.data;
  return typeof d.max === 'string' && typeof d.telegram === 'string' ? { max: d.max, telegram: d.telegram } : null;
}

const LINK_CLASS =
  'shrink-0 inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-lg text-xs font-medium transition-colors duration-200';

// Скрытие помнит состояние плашки (lib/hub/plaque-dismiss): закрытая мягкая
// подсказка не прячет предупреждение «не дойдут», а оно само — лишь до конца сессии.
const DISMISS_KEY = 'vedar.member-channel-banner.dismissed';

export function MemberChannelBanner() {
  const [channel, setChannel] = useState<MemberChannel | null>(null);
  const [links, setLinks] = useState<Links | null>(null);
  const [linksFailed, setLinksFailed] = useState(false);
  const [hidden, setHidden] = useState<ChannelPlaque | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/hub/operator/me/messenger', { signal: ctrl.signal })
      .then(async (res) => {
        const ch = res.ok ? readMemberChannel(await res.json().catch(() => null)) : null;
        if (!ch || ctrl.signal.aborted) return;
        setChannel(ch);
        if (ch.max) return;
        // Ссылка — действующий ключ привязки: выдаётся, только когда нужна.
        const lr = await fetch('/api/hub/operator/me/messenger', { method: 'POST', signal: ctrl.signal });
        const l = lr.ok ? readLinks(await lr.json().catch(() => null)) : null;
        if (ctrl.signal.aborted) return;
        if (l) setLinks(l);
        else setLinksFailed(true);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);

  const plaque: ChannelPlaque | null = channel && !channel.max ? (!channel.telegram ? 'none' : 'telegram') : null;
  const dismissed = plaque !== null && (hidden === plaque || isPlaqueDismissed(DISMISS_KEY, plaque));
  if (!channel || channel.max || dismissed) return null;
  const none = plaque === 'none';
  const sentence = linksFailed
    ? 'Ссылка для подключения сейчас не выдаётся — попробуйте позже.'
    : none
      ? 'Подключите MAX — туда будут приходить новые брони, заявки, запросы мест и напоминания о задачах кабинета. Ссылка действует сутки.'
      : 'Брони, заявки и напоминания приходят вам в Telegram без имён и телефонов клиентов: их платформа отправляет только в MAX.';

  function hide() {
    if (!plaque) return;
    setHidden(plaque);
    rememberPlaqueDismissed(DISMISS_KEY, plaque, 'member-channel-banner');
  }

  return (
    <div
      role="status"
      className={`mx-3 mt-3 min-w-0 max-w-full rounded-lg border bg-[var(--bg-card)] px-2 py-1 ${none ? 'border-[var(--warning)]' : 'border-[var(--border)]'}`}
    >
      <div className="flex items-center gap-2 min-h-[44px] min-w-0">
        {none
          ? <BellOff className="w-4 h-4 text-[var(--warning)] shrink-0" />
          : <MessageCircle className="w-4 h-4 text-[var(--ocean)] shrink-0" />}
        {/* Предупреждение не режется в одну строку: на 390px последствие и
            «нажмите Старт» оставались только в title, а наведения на телефоне нет. */}
        <p
          className={`flex-1 min-w-0 text-sm text-[var(--text-primary)] ${none ? 'break-words py-2' : 'truncate'}`}
          title={none ? undefined : sentence}
        >
          {sentence}
        </p>
        <button
          type="button"
          onClick={hide}
          aria-label="Скрыть подсказку"
          className="shrink-0 inline-flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-200"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {links && (
        <div className="flex flex-wrap gap-2 min-w-0 pb-1">
          <a href={links.max} target="_blank" rel="noopener noreferrer" className={`${LINK_CLASS} max-w-full ds-btn-primary`}>
            Подключить MAX
            <ExternalLink className="w-3 h-3" />
          </a>
          {!channel.telegram && (
            <a
              href={links.telegram}
              target="_blank"
              rel="noopener noreferrer"
              className={`${LINK_CLASS} max-w-full text-[var(--ocean)] hover:bg-[var(--bg-hover)]`}
            >
              Подключить Telegram
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
