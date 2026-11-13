'use client';

/**
 * Заявка в виде билета на странице `/request-status` (12.11, «Boarding pass»
 * из каталога Motion, написано заново).
 *
 * Билет — только форма: всё на нём из той же заявки, что страница уже
 * показывает. Бронью он не притворяется (поручение владельца: «билет не должен
 * выглядеть как подтверждённая бронь»): сверху написано «Заявка», нет ни
 * штрихкода, ни QR, ни номера места, а корешок говорит, кто подтверждает и
 * что платформа не берёт оплату. Подтверждение адресата — словами адресата,
 * не «бронь оформлена».
 *
 * Появление — подъём и проявление переходом Tailwind после первого кадра; при
 * «уменьшить движение» билет сразу на месте.
 */

import { useEffect, useState } from 'react';
import { platformAcceptsPayments } from '@/lib/payments/accepting';
import { ADDRESSEE_WORDS, capitalized, type ConsentPurpose, type RequestKind, type RequestState } from '@/lib/mcp/request-status-schema';

export interface TicketView {
  state: RequestState;
  kind: RequestKind;
  consent_purpose: ConsentPurpose;
  tour: string | null;
  accommodation: string | null;
  date: string | null;
  check_out: string | null;
  participants: number | null;
}

function kindWord(v: Pick<TicketView, 'kind' | 'consent_purpose'>): string {
  if (v.kind === 'stay_request') return 'Жильё';
  if (v.consent_purpose === 'carrier') return 'Машина под заказ';
  if (v.consent_purpose === 'rental') return 'Прокат';
  return 'Тур';
}

function dateRu(value: string | null): string | null {
  if (!value) return null;
  const t = new Date(`${value}T00:00:00`);
  return Number.isNaN(t.getTime()) ? value : t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Строка корешка: кто подтверждает и что с оплатой. */
export function ticketStub(v: Pick<TicketView, 'state' | 'consent_purpose'>): string {
  const w = ADDRESSEE_WORDS[v.consent_purpose];
  const pays = platformAcceptsPayments();
  if (v.state === 'confirmed') {
    return pays ? `${capitalized(w.nom)} подтвердил заявку.` : `${capitalized(w.nom)} подтвердил заявку. Оплата — ${w.dat} напрямую, не через платформу.`;
  }
  return `Это заявка, а не бронь: подтверждает ${w.nom}.${pays ? '' : ' Платформа оплату не принимает.'}`;
}

/** null — на билет нечего написать: ни названия, ни даты. */
export function RequestTicket({ view }: { view: TicketView }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const stay = view.kind === 'stay_request';
  const title = stay ? view.accommodation : view.tour;
  const from = dateRu(view.date);
  if (!title && !from) return null;

  const fields: { label: string; value: string }[] = [];
  if (stay) {
    if (from) fields.push({ label: 'Заезд', value: from });
    const to = dateRu(view.check_out);
    if (to) fields.push({ label: 'Выезд', value: to });
    if (view.participants) fields.push({ label: 'Гостей', value: String(view.participants) });
  } else {
    if (from) fields.push({ label: 'Дата', value: from });
    if (view.participants) fields.push({ label: 'Участников', value: String(view.participants) });
  }

  return (
    <section
      aria-label="Заявка"
      data-request-ticket
      className={`relative rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide text-[var(--text-secondary)]">
          <span>Заявка</span>
          <span>{kindWord(view)}</span>
        </div>
        {title && (
          <p className="text-lg font-bold leading-snug text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
            {title}
          </p>
        )}
        {fields.length > 0 && (
          <dl className="grid grid-cols-2 gap-3">
            {fields.map((f) => (
              <div key={f.label}>
                <dt className="text-xs text-[var(--text-muted)]">{f.label}</dt>
                <dd className="text-sm font-medium text-[var(--text-primary)]">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {/* Линия отрыва с вырезами по краям — цвет вырезов равен фону карточки. */}
      <div className="relative h-0" aria-hidden="true">
        <span className="absolute -left-2 -top-2 w-4 h-4 rounded-full bg-[var(--bg-card)] border border-[var(--border)]" />
        <span className="absolute -right-2 -top-2 w-4 h-4 rounded-full bg-[var(--bg-card)] border border-[var(--border)]" />
        <div className="mx-3 border-t border-dashed border-[var(--border)]" />
      </div>
      <p className="px-4 py-3 text-xs text-[var(--text-secondary)]" data-ticket-stub>{ticketStub(view)}</p>
    </section>
  );
}
