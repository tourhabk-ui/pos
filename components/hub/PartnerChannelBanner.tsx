'use client';

/**
 * «Подключите MAX или Telegram» — баннер в кабинетах всех шести ролей
 * партнёров (CRM 1в-3, #2325). Показывается, только когда известно, что
 * партнёру слать некуда: ни MAX, ни Telegram. Правило «достижим» — то же,
 * по которому доставляют заявки и напоминания (`reachForPartner`, через
 * `/api/hub/crm/channel`), а не одна колонка: прежний баннер оператора
 * смотрел только users.telegram_id и звал подключить Telegram того, кому
 * заявки уже приходили в MAX.
 *
 * Сбой проверки — баннера нет: «не подключено» на сбое соврало бы тому, у
 * кого всё подключено (§4.0). Подключение — путями, где право проверено:
 * Telegram — ссылкой для вошедшего (`/api/telegram/connect`), MAX — по
 * ссылке администратора (правило 29.09, lib/partners/channel-link.ts).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BellOff, ExternalLink, X } from 'lucide-react';

interface Channel {
  reachable: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readChannel(json: unknown): Channel | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  return typeof json.data.reachable === 'boolean' ? { reachable: json.data.reachable } : null;
}

export function PartnerChannelBanner() {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/hub/crm/channel', { signal: ctrl.signal })
      .then(async (res) => {
        const ch = res.ok ? readChannel(await res.json().catch(() => null)) : null;
        if (!ch || ctrl.signal.aborted) return;
        setChannel(ch);
        if (ch.reachable) return;
        const tg: unknown = await fetch('/api/telegram/connect', { signal: ctrl.signal }).then((r) => r.json()).catch(() => null);
        if (!ctrl.signal.aborted && isRecord(tg) && typeof tg.link === 'string') setTgLink(tg.link);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);

  if (!channel || channel.reachable || dismissed) return null;

  return (
    <div
      role="status"
      className="mx-5 mt-5 flex items-start gap-3 rounded-lg border border-[var(--warning)] bg-[var(--bg-card)] px-4 py-3"
    >
      <BellOff className="w-4 h-4 mt-0.5 text-[var(--warning)] shrink-0" />
      <div className="flex-1 space-y-1">
        <p className="text-sm text-[var(--text-primary)]">
          Не подключён ни MAX, ни Telegram — новые заявки и напоминания о задачах до вас не дойдут.
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          MAX подключается по ссылке от администратора платформы —{' '}
          <Link href="/contact" className="text-[var(--ocean)] hover:underline">напишите нам</Link>, пришлём её.
        </p>
      </div>
      {tgLink && (
        <a
          href={tgLink}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-lg text-xs font-medium text-[var(--ocean)] hover:bg-[var(--bg-hover)] transition-colors duration-200"
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
