'use client';

/**
 * «Подключите MAX» — баннер в кабинетах всех шести ролей партнёров
 * (CRM 1в-3, #2325). Правило «подключён» — то же, по которому доставляют
 * заявки и напоминания (`reachForPartner`, через `/api/hub/crm/channel`), а
 * не одна колонка: прежний баннер оператора смотрел только users.telegram_id
 * и звал подключить Telegram того, кому заявки уже приходили в MAX.
 *
 * Два состояния:
 *  - нет ни MAX, ни Telegram — новые заявки и напоминания не дойдут вовсе;
 *  - есть только Telegram — дойдут без имён и телефонов: ПД туристов уходят
 *    только в MAX (решение владельца 23.08, lib/notifications/pd-alert).
 *
 * Кнопки — ссылки на СВОЮ карточку партнёра (`/api/hub/crm/channel/link`,
 * решение владельца 09.10): подпись, срок 72 часа, о перепривязке узнают
 * администратор и прежний чат. Сбой проверки — баннера нет: «не подключено»
 * на сбое соврало бы тому, у кого всё подключено (§4.0).
 */
import { useEffect, useState } from 'react';
import { BellOff, ExternalLink, MessageCircle, X } from 'lucide-react';

interface Channel {
  reachable: boolean;
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

function readChannel(json: unknown): Channel | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  const d = json.data;
  return typeof d.reachable === 'boolean' && typeof d.max === 'boolean' && typeof d.telegram === 'boolean'
    ? { reachable: d.reachable, max: d.max, telegram: d.telegram }
    : null;
}

function readLinks(json: unknown): Links | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  const d = json.data;
  return typeof d.max === 'string' && typeof d.telegram === 'string' ? { max: d.max, telegram: d.telegram } : null;
}

const LINK_CLASS =
  'shrink-0 inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-lg text-xs font-medium transition-colors duration-200';

export function PartnerChannelBanner() {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [links, setLinks] = useState<Links | null>(null);
  const [linksFailed, setLinksFailed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/hub/crm/channel', { signal: ctrl.signal })
      .then(async (res) => {
        const ch = res.ok ? readChannel(await res.json().catch(() => null)) : null;
        if (!ch || ctrl.signal.aborted) return;
        setChannel(ch);
        if (ch.max) return;
        // Ссылка — действующий ключ привязки: выдаётся, только когда нужна.
        const lr = await fetch('/api/hub/crm/channel/link', { method: 'POST', signal: ctrl.signal });
        const l = lr.ok ? readLinks(await lr.json().catch(() => null)) : null;
        if (ctrl.signal.aborted) return;
        if (l) setLinks(l);
        else setLinksFailed(true);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);

  if (!channel || channel.max || dismissed) return null;
  const none = !channel.reachable;

  return (
    <div
      role="status"
      className={`mx-5 mt-5 flex items-start gap-3 flex-wrap sm:flex-nowrap rounded-lg border bg-[var(--bg-card)] px-4 py-3 ${none ? 'border-[var(--warning)]' : 'border-[var(--border)]'}`}
    >
      {none
        ? <BellOff className="w-4 h-4 mt-0.5 text-[var(--warning)] shrink-0" />
        : <MessageCircle className="w-4 h-4 mt-0.5 text-[var(--ocean)] shrink-0" />}
      <div className="flex-1 min-w-[200px] space-y-1">
        <p className="text-sm text-[var(--text-primary)]">
          {none
            ? 'Не подключён ни MAX, ни Telegram — новые заявки и напоминания о задачах до вас не дойдут.'
            : 'Заявки и напоминания приходят в Telegram без имён и телефонов клиентов: их платформа отправляет только в MAX.'}
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          {linksFailed
            ? 'Ссылка для подключения сейчас не выдаётся — попробуйте позже.'
            : 'Откроется бот Ведара — нажмите «Старт», и чат подключится к карточке вашей компании. Ссылка действует 72 часа.'}
        </p>
      </div>
      {links && (
        <a href={links.max} target="_blank" rel="noopener noreferrer" className={`${LINK_CLASS} ds-btn-primary`}>
          Подключить MAX
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
      {links && !channel.telegram && (
        <a
          href={links.telegram}
          target="_blank"
          rel="noopener noreferrer"
          className={`${LINK_CLASS} text-[var(--ocean)] hover:bg-[var(--bg-hover)]`}
        >
          Подключить Telegram
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Скрыть подсказку"
        className="shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-200"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
