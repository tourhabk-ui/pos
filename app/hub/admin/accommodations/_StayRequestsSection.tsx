'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Inbox, Loader2, CheckCircle2, XCircle, HelpCircle, Phone, RefreshCw } from 'lucide-react';
import { Sensitive } from '@/components/admin/shared/Sensitive';
import { nightsBetween, ownerDeliveryLabel, platformDeliveryLabel, ruDate } from '@/lib/stay/stay-request';

/**
 * Заявки гостей хозяевам жилья (1206, 1213). Повод — 10.10: тестовая заявка
 * владельца в «Кутху» была в базе, а на экране — нигде. Здесь каждая заявка
 * целиком и то, куда она дошла: хозяину и платформе отдельно. Заявку, которая
 * хозяину не дошла, администратор подхватывает отсюда — телефон гостя здесь.
 */

interface StayRequestItem {
  id: string;
  createdAt: string;
  accommodationId: string;
  accommodationName: string;
  partnerName: string | null;
  ownerOnMax: boolean;
  ownerOnTelegram: boolean;
  checkIn: string;
  checkOut: string;
  guests: number;
  guestName: string;
  guestPhone: string;
  comment: string | null;
  door: string | null;
  ownerChannel: string | null;
  ownerReason: string | null;
  platformChannel: string | null;
  platformReason: string | null;
  deliveryRecordedAt: string | null;
}

function isList(v: unknown): v is { success: true; data: { total: number; requests: StayRequestItem[] } } {
  if (typeof v !== 'object' || v === null) return false;
  const d = (v as { data?: unknown }).data;
  return typeof d === 'object' && d !== null && Array.isArray((d as { requests?: unknown }).requests);
}

const kamchatkaTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Kamchatka', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

const DOOR_LABELS: Record<string, string> = {
  form: 'форма на карточке',
  mcp: 'через ассистента (MCP)',
};

function DeliveryLine({ label, reason }: { label: { text: string; ok: boolean | null }; reason: string | null }) {
  const Icon = label.ok === true ? CheckCircle2 : label.ok === false ? XCircle : HelpCircle;
  const color = label.ok === true ? 'text-[var(--success)]' : label.ok === false ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]';
  return (
    <p className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${color}`} />
      <span>
        {label.text}
        {label.ok === false && reason ? <span className="text-[var(--text-muted)]"> — {reason}</span> : null}
      </span>
    </p>
  );
}

export function StayRequestsSection() {
  const [items, setItems] = useState<StayRequestItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);

  // Перезагрузка — сменой ключа; состояние сбрасывает нажатие, а не эффект:
  // синхронный setState в эффекте линтер эры React Compiler считает каскадом.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/admin/stay-requests?limit=50', { signal: ctrl.signal })
      .then(async (res) => {
        const j: unknown = await res.json().catch(() => null);
        if (ctrl.signal.aborted) return;
        if (!res.ok || !isList(j)) {
          const msg = typeof j === 'object' && j !== null && 'error' in j ? String((j as { error: unknown }).error) : null;
          setFailed(msg ?? 'Заявки не загружены');
          return;
        }
        setFailed(null);
        setItems(j.data.requests);
        setTotal(j.data.total);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed('Сетевая ошибка — заявки не загружены');
      });
    return () => ctrl.abort();
  }, [reloadKey]);

  // Ссылка из уведомления ведёт на #requests; секция появляется после
  // проверки входа, и браузер к ней сам уже не прокрутит.
  useEffect(() => {
    if (items !== null && typeof window !== 'undefined' && window.location.hash === '#requests') {
      document.getElementById('requests')?.scrollIntoView({ block: 'start' });
    }
  }, [items]);

  return (
    <section id="requests" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-8 scroll-mt-4">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-2">
          <Inbox className="w-5 h-5 text-[var(--accent)]" />
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Заявки гостей</h2>
          {items !== null && total > 0 && (
            <span className="text-xs text-[var(--text-muted)]">
              {total > items.length ? `последние ${items.length} из ${total}` : total}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => { setItems(null); setFailed(null); setReloadKey((k) => k + 1); }}
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          aria-label="Обновить заявки"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Заявки хозяевам жилья без своей брони — с карточки объекта и от ассистентов. Это не бронь: даты и цену подтверждает хозяин.
        Где хозяину не дошло — позвоните гостю или передайте заявку хозяину сами.
      </p>

      {failed && <p className="text-sm text-[var(--danger)]">{failed}</p>}

      {!failed && items === null && (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
        </div>
      )}

      {items !== null && items.length === 0 && (
        <p className="text-sm text-[var(--text-muted)] py-4">Заявок ещё не было.</p>
      )}

      {items !== null && items.length > 0 && (
        <div className="space-y-2">
          {items.map((r) => {
            const nights = nightsBetween(r.checkIn, r.checkOut);
            const owner = ownerDeliveryLabel(r.ownerChannel);
            return (
              <div key={r.id} className="border border-[var(--border)] rounded-lg p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <Link
                      href={`/accommodations/${r.accommodationId}`}
                      className="font-medium text-[var(--text-primary)] hover:text-[var(--ocean)] transition-colors"
                    >
                      {r.accommodationName}
                    </Link>
                    <p className="text-sm text-[var(--text-secondary)]">
                      {ruDate(r.checkIn)} → {ruDate(r.checkOut)}
                      {nights !== null && ` · ночей: ${nights}`} · гостей: {r.guests}
                    </p>
                  </div>
                  <p className="text-xs text-[var(--text-muted)] text-right">
                    {kamchatkaTime.format(new Date(r.createdAt))} по Камчатке
                    <br />
                    {r.door ? DOOR_LABELS[r.door] ?? r.door : 'откуда — не записано'}
                  </p>
                </div>

                <div className="mt-2 flex items-center gap-2 flex-wrap text-sm">
                  <Sensitive className="text-[var(--text-primary)]">{r.guestName}</Sensitive>
                  <a
                    href={`tel:${r.guestPhone.replace(/[^\d+]/g, '')}`}
                    className="inline-flex items-center gap-1 text-[var(--ocean)] hover:underline"
                  >
                    <Phone className="w-3.5 h-3.5" />
                    <Sensitive>{r.guestPhone}</Sensitive>
                  </a>
                </div>
                {r.comment && (
                  <p className="mt-1 text-sm text-[var(--text-secondary)] whitespace-pre-line">
                    <Sensitive>{r.comment}</Sensitive>
                  </p>
                )}

                <div className="mt-2 space-y-0.5">
                  <DeliveryLine label={owner} reason={r.ownerReason} />
                  <DeliveryLine label={platformDeliveryLabel(r.platformChannel)} reason={r.platformReason} />
                </div>

                {!r.ownerOnMax && (
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    {r.partnerName ? `«${r.partnerName}»` : 'Хозяин'} сейчас не подключён к MAX
                    {r.ownerOnTelegram ? ' (есть только Telegram — туда уходит заглушка без имени и телефона)' : ''}.
                    Ссылку на бота даёт кнопка в разделе{' '}
                    <Link href="/hub/admin/operators" className="text-[var(--ocean)] hover:underline">Операторы</Link>.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
