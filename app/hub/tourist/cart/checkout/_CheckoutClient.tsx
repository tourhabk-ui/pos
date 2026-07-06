'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Calendar, Users, Phone, Mail, User, ChevronRight,
  CheckCircle, AlertTriangle, ShoppingCart, ArrowLeft,
} from 'lucide-react';
import { useCart, type CartItem } from '@/contexts/CartContext';
import TourDateField from '@/components/marketplace/TourDateField';

/**
 * Чекаут корзины: контакты — один раз, дата/участники — на каждый тур.
 * Заявки создаются ПОСЛЕДОВАТЕЛЬНО через POST /api/hub/bookings/create
 * (rate-limit 5/мин на IP + FOR UPDATE в транзакции — параллель опасна):
 * успешные удаляются из корзины, отклонённые (422) остаются с текстом
 * ошибки сервера, 429 прерывает цикл («оформлено X из N»).
 */

interface PerTourForm {
  booking_date: string;
  participants_count: string;
  special_requests: string;
}

type TourResult =
  | { status: 'ok'; bookingId: string | number }
  | { status: 'error'; message: string };

function formatPrice(p: number): string {
  return new Intl.NumberFormat('ru-RU').format(p) + ' ₽';
}

const EMPTY_FORM: PerTourForm = { booking_date: '', participants_count: '1', special_requests: '' };

export default function CheckoutClient() {
  const { items, remove } = useCart();
  const router = useRouter();

  const [contacts, setContacts] = useState({ tourist_name: '', tourist_phone: '', tourist_email: '' });
  const [forms, setForms] = useState<Record<number, PerTourForm>>({});
  const [results, setResults] = useState<Record<number, TourResult>>({});
  const [submitting, setSubmitting] = useState(false);
  const [rateLimited, setRateLimited] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState(0);

  // Преднаполнить контакты из профиля (cookie-сессия)
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { name?: string; email?: string } } | null) => {
        if (d?.success && d.data) {
          setContacts(prev => ({
            ...prev,
            tourist_name: prev.tourist_name || d.data?.name || '',
            tourist_email: prev.tourist_email || d.data?.email || '',
          }));
        }
      })
      .catch(() => {});
  }, []);

  const getForm = (tourId: number): PerTourForm => forms[tourId] ?? EMPTY_FORM;
  const setForm = (tourId: number, patch: Partial<PerTourForm>) =>
    setForms(prev => ({ ...prev, [tourId]: { ...getForm(tourId), ...patch } }));

  // Туры, ещё не оформленные успешно (успешные удаляются из корзины)
  const pendingItems = items;
  const allDatesChosen = pendingItems.every(i => getForm(i.tourId).booking_date);
  const contactsFilled = contacts.tourist_name.length >= 2 && contacts.tourist_phone.length >= 10;

  const total = pendingItems.reduce(
    (sum, i) => sum + i.price * (parseInt(getForm(i.tourId).participants_count) || 1), 0
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setRateLimited(null);

    // Снимок списка: remove() меняет items по ходу цикла
    const queue = [...pendingItems];
    let successCount = doneCount;
    const sessionOk: Array<{ tourId: number; bookingId: string | number }> = [];

    for (const item of queue) {
      const form = getForm(item.tourId);
      if (!form.booking_date) continue;

      try {
        const res = await fetch('/api/hub/bookings/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tour_id: item.tourId,
            tourist_name: contacts.tourist_name,
            tourist_phone: contacts.tourist_phone,
            tourist_email: contacts.tourist_email || undefined,
            booking_date: form.booking_date,
            participants_count: parseInt(form.participants_count) || 1,
            special_requests: form.special_requests || undefined,
          }),
        });

        if (res.status === 429) {
          // Rate-limit: прерываем, оставшиеся туры не трогаем
          setRateLimited(
            `Оформлено ${successCount} из ${queue.length + doneCount}. ` +
            'Остальные заявки можно отправить через минуту — сработала защита от частых запросов.'
          );
          break;
        }

        const data: unknown = await res.json();
        if (res.ok && typeof data === 'object' && data !== null && 'booking_id' in data) {
          const bookingId = (data as Record<string, unknown>).booking_id as string | number;
          setResults(prev => ({ ...prev, [item.tourId]: { status: 'ok', bookingId } }));
          sessionOk.push({ tourId: item.tourId, bookingId });
          remove(item.tourId);
          successCount++;
        } else {
          const msg = typeof data === 'object' && data !== null && 'error' in data
            ? String((data as Record<string, unknown>).error)
            : 'Не удалось создать заявку';
          setResults(prev => ({ ...prev, [item.tourId]: { status: 'error', message: msg } }));
        }
      } catch {
        setResults(prev => ({
          ...prev,
          [item.tourId]: { status: 'error', message: 'Ошибка сети. Попробуйте ещё раз.' },
        }));
      }
    }

    setDoneCount(successCount);
    setSubmitting(false);

    // Единственный тур оформлен → сразу на привычную страницу успеха
    if (queue.length === 1 && doneCount === 0 && sessionOk.length === 1) {
      router.push(`/booking-success/${sessionOk[0].bookingId}`);
    }
  };

  const okEntries = Object.entries(results).filter(([, r]) => r.status === 'ok') as
    Array<[string, { status: 'ok'; bookingId: string | number }]>;

  // Всё из корзины оформлено
  if (pendingItems.length === 0 && okEntries.length > 0) {
    return (
      <div className="ds-page pt-20 pb-16">
        <div className="max-w-xl mx-auto text-center py-16 space-y-5">
          <CheckCircle className="w-12 h-12 mx-auto text-[var(--success)]" />
          <h1 className="ds-h2">Заявки оформлены</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Операторы получили уведомления и свяжутся с вами. Каждую заявку можно открыть:
          </p>
          <div className="space-y-2">
            {okEntries.map(([tourId, r]) => (
              <Link
                key={tourId}
                href={`/booking-success/${r.bookingId}`}
                className="block rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--ocean)] hover:border-[var(--success)] transition-colors"
              >
                Заявка №{r.bookingId} →
              </Link>
            ))}
          </div>
          <button onClick={() => router.push('/marketplace')} className="ds-btn ds-btn-secondary px-6 py-2.5">
            Вернуться в каталог
          </button>
        </div>
      </div>
    );
  }

  // Корзина пуста и ничего не оформляли
  if (pendingItems.length === 0) {
    return (
      <div className="ds-page pt-20 pb-16">
        <div className="max-w-xl mx-auto text-center py-24 space-y-4">
          <ShoppingCart className="w-12 h-12 mx-auto text-[var(--text-muted)]" />
          <h1 className="ds-h2">Корзина пуста</h1>
          <button onClick={() => router.push('/marketplace')} className="ds-btn ds-btn-primary px-6 py-2.5">
            Перейти в каталог
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-page pt-20 pb-16">
      <div className="max-w-2xl mx-auto">
        <Link href="/hub/tourist/cart" className="inline-flex items-center gap-1.5 text-sm text-[var(--ocean)] hover:underline mb-4">
          <ArrowLeft className="w-4 h-4" /> Назад в корзину
        </Link>

        <h1 className="ds-h1 mb-1">Оформление заявок</h1>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          Контакты — один раз, дата и участники — для каждого тура. Финальные условия подтверждаются оператором перед оплатой.
        </p>

        {/* Частично оформлено: успехи этой сессии, пока остальные правятся */}
        {okEntries.length > 0 && (
          <div className="mb-5 space-y-2">
            {okEntries.map(([tourId, r]) => (
              <Link
                key={tourId}
                href={`/booking-success/${r.bookingId}`}
                className="flex items-center gap-2 rounded-lg border border-[var(--success)] bg-[var(--bg-card)] px-4 py-2.5 text-sm text-[var(--success)]"
              >
                <CheckCircle className="w-4 h-4 shrink-0" />
                Заявка №{r.bookingId} оформлена →
              </Link>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Контакты — общие на весь заказ */}
          <div className="ds-card p-5 space-y-4">
            <h2 className="ds-h2 text-base">Контакты</h2>
            <div>
              <label className="ds-label flex items-center gap-1.5 mb-1.5">
                <User className="w-3.5 h-3.5" /> Имя *
              </label>
              <input
                type="text" value={contacts.tourist_name}
                onChange={e => setContacts(p => ({ ...p, tourist_name: e.target.value }))}
                placeholder="Иван Иванов" className="ds-input w-full" required minLength={2}
              />
            </div>
            <div>
              <label className="ds-label flex items-center gap-1.5 mb-1.5">
                <Phone className="w-3.5 h-3.5" /> Телефон *
              </label>
              <input
                type="tel" value={contacts.tourist_phone}
                onChange={e => setContacts(p => ({ ...p, tourist_phone: e.target.value }))}
                placeholder="+7 900 000 00 00" className="ds-input w-full" required minLength={10}
              />
            </div>
            <div>
              <label className="ds-label flex items-center gap-1.5 mb-1.5">
                <Mail className="w-3.5 h-3.5" /> Email
              </label>
              <input
                type="email" value={contacts.tourist_email}
                onChange={e => setContacts(p => ({ ...p, tourist_email: e.target.value }))}
                placeholder="ivan@example.com" className="ds-input w-full"
              />
            </div>
          </div>

          {/* Пер-тур блоки */}
          {pendingItems.map(item => (
            <CheckoutTourBlock
              key={item.tourId}
              item={item}
              form={getForm(item.tourId)}
              onChange={patch => setForm(item.tourId, patch)}
              result={results[item.tourId]}
            />
          ))}

          {rateLimited && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)] bg-[var(--bg-card)] p-3 text-sm text-[var(--warning)]">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              {rateLimited}
            </div>
          )}

          {/* Итог */}
          <div className="ds-card p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-[var(--text-muted)]">{pendingItems.length} тур(а) в заказе</p>
                <p className="text-2xl font-bold text-[var(--text-primary)]">{formatPrice(total)}</p>
                <p className="text-xs text-[var(--text-muted)]">предварительно, «от»</p>
              </div>
              <button
                type="submit"
                disabled={submitting || !allDatesChosen || !contactsFilled}
                className="ds-btn ds-btn-primary flex items-center gap-2 px-6"
              >
                {submitting ? (
                  <span className="animate-spin rounded-full h-4 w-4 border border-white border-t-transparent" />
                ) : (
                  <>
                    Оформить заявки
                    <ChevronRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
            {!allDatesChosen && (
              <p className="text-xs text-[var(--text-muted)] mt-2">Выберите дату для каждого тура</p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function CheckoutTourBlock({ item, form, onChange, result }: {
  item: CartItem;
  form: PerTourForm;
  onChange: (patch: Partial<PerTourForm>) => void;
  result?: TourResult;
}) {
  return (
    <div className={`ds-card p-5 space-y-4 ${result?.status === 'error' ? 'border-[var(--danger)]' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-[var(--text-primary)]">{item.title}</h3>
          <p className="text-xs text-[var(--text-muted)]">{item.operatorName} · от {formatPrice(item.price)}</p>
        </div>
      </div>

      {result?.status === 'error' && (
        <div className="rounded-lg border border-[var(--danger)] bg-[var(--danger)]/10 p-3 text-sm text-[var(--danger)]">
          {result.message}
        </div>
      )}

      <div>
        <label className="ds-label flex items-center gap-1.5 mb-1.5">
          <Calendar className="w-3.5 h-3.5" /> Дата заезда *
        </label>
        <TourDateField
          tourId={item.tourId}
          tourTitle={item.title}
          value={form.booking_date}
          onChange={date => onChange({ booking_date: date })}
          inputName={`booking_date_${item.tourId}`}
        />
      </div>

      <div>
        <label className="ds-label flex items-center gap-1.5 mb-1.5">
          <Users className="w-3.5 h-3.5" /> Участники *
        </label>
        <select
          value={form.participants_count}
          onChange={e => onChange({ participants_count: e.target.value })}
          className="ds-input w-full"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
            <option key={n} value={n}>{n} {n === 1 ? 'человек' : n < 5 ? 'человека' : 'человек'}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="ds-label mb-1.5">Пожелания оператору</label>
        <textarea
          value={form.special_requests}
          onChange={e => onChange({ special_requests: e.target.value })}
          className="ds-input w-full resize-none"
          rows={2}
          placeholder="Особые пожелания..."
        />
      </div>
    </div>
  );
}
