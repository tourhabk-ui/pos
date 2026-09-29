'use client';

/**
 * Запрос свободных мест у оператора из планера (решение владельца 29.09).
 *
 * Турист называет дату и число людей, оператор отвечает одним нажатием в
 * мессенджере; «Есть места» сразу заводит подтверждённую бронь. Ответ туристу
 * — туда, где ему удобно: после отправки форма показывает ссылки на ботов
 * Telegram и MAX (нажать «Старт» — и ответ придёт туда) и ссылку на страницу
 * статуса, которая работает всегда.
 *
 * WhatsApp и звонок: ответ придёт на страницу статуса, а оператор с
 * подтверждённой бронью свяжется по телефону. Писать туристу в WhatsApp
 * первыми мы не можем без утверждённых шаблонов Meta — это отдельное решение.
 */

import { useState } from 'react';
import { Loader2, X, Send, MessageCircle, Phone, ExternalLink } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';

type ReplyChannel = 'telegram' | 'max' | 'whatsapp' | 'phone';

const CHANNELS: { value: ReplyChannel; label: string }[] = [
  { value: 'max', label: 'MAX' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'phone', label: 'Звонок' },
];

interface Created {
  status_url: string;
  deadline_at: string;
  bot_links: { telegram: string; max: string };
}

export function SeatRequestForm({
  tour, defaultDate, defaultParticipants, onClose,
}: {
  tour: { id: string; title: string };
  defaultDate: string;
  defaultParticipants: number;
  onClose: () => void;
}) {
  const [date, setDate] = useState(defaultDate);
  const [participants, setParticipants] = useState(Math.max(1, defaultParticipants));
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState<ReplyChannel>('max');
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  // Сегодня по Камчатке (UTC+12) — нижняя граница выбора даты.
  const [today] = useState(() => new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 10));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!consent) { setError('Нужно согласие на обработку персональных данных'); return; }
    setSending(true);
    try {
      const res = await fetch('/api/seat-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tour_id: tour.id, date, participants,
          tourist_name: name, tourist_phone: phone,
          reply_channel: channel, pd_consent: true,
        }),
      });
      const body = await res.json().catch(() => null) as
        | { success: true; data: Created }
        | { success: false; error?: string }
        | null;
      if (!res.ok || !body || !body.success) {
        setError((body && !body.success && body.error) || `Сервер ответил ${res.status}`);
        return;
      }
      setCreated(body.data);
    } catch {
      setError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    } finally {
      setSending(false);
    }
  }

  const deadline = created
    ? new Date(created.deadline_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="seat-request-title">
      <div className="ds-card w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-lg sm:rounded-lg p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="seat-request-title" className="text-xl font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
              Уточнить места у оператора
            </h2>
            <p className="text-sm text-[var(--text-secondary)] mt-1">{tour.title}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {created ? (
          <div className="space-y-3" aria-live="polite">
            <p className="text-sm text-[var(--text-primary)]">
              Запрос отправлен оператору. Ответ — до {deadline}. Если места есть, бронь заведётся сразу и вы получите ссылку на оплату.
            </p>
            {(channel === 'telegram' || channel === 'max') ? (
              <>
                <p className="text-sm text-[var(--text-secondary)]">
                  Чтобы ответ пришёл в {channel === 'max' ? 'MAX' : 'Telegram'}, откройте бота и нажмите «Старт»:
                </p>
                <a
                  href={channel === 'max' ? created.bot_links.max : created.bot_links.telegram}
                  target="_blank" rel="noopener noreferrer"
                  className="ds-btn ds-btn-primary w-full inline-flex items-center justify-center gap-2"
                >
                  <Send className="w-4 h-4" />
                  Получать ответ в {channel === 'max' ? 'MAX' : 'Telegram'}
                </a>
              </>
            ) : (
              <p className="text-sm text-[var(--text-secondary)]">
                {channel === 'whatsapp'
                  ? 'Писать в WhatsApp первыми мы пока не можем: ответ появится на странице запроса, а при подтверждении оператор свяжется по телефону.'
                  : 'Ответ появится на странице запроса; при подтверждении оператор позвонит.'}
              </p>
            )}
            <a href={created.status_url} target="_blank" rel="noopener noreferrer"
               className="ds-btn ds-btn-secondary w-full inline-flex items-center justify-center gap-2">
              <ExternalLink className="w-4 h-4" />
              Страница запроса — сохраните ссылку
            </a>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="ds-label">Дата</span>
                <input type="date" required min={today} value={date} onChange={e => setDate(e.target.value)} className="ds-input w-full" />
              </label>
              <label className="block">
                <span className="ds-label">Человек</span>
                <input type="number" required min={1} max={100} value={participants}
                       onChange={e => setParticipants(Math.max(1, Number(e.target.value) || 1))} className="ds-input w-full" />
              </label>
            </div>
            <label className="block">
              <span className="ds-label">Имя</span>
              <input required minLength={2} maxLength={255} value={name} onChange={e => setName(e.target.value)} className="ds-input w-full" autoComplete="name" />
            </label>
            <label className="block">
              <span className="ds-label">Телефон</span>
              <input required type="tel" minLength={10} maxLength={20} value={phone} onChange={e => setPhone(e.target.value)} className="ds-input w-full" autoComplete="tel" placeholder="+7 900 000-00-00" />
            </label>
            <fieldset>
              <legend className="ds-label">Где получить ответ</legend>
              <div className="grid grid-cols-4 gap-1.5 mt-1">
                {CHANNELS.map(c => (
                  <button key={c.value} type="button" onClick={() => setChannel(c.value)}
                          aria-pressed={channel === c.value}
                          className={`text-xs py-2 rounded-md border transition-all duration-200 inline-flex items-center justify-center gap-1 ${
                            channel === c.value
                              ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--bg-hover)]'
                              : 'border-[var(--border)] text-[var(--text-secondary)]'}`}>
                    {c.value === 'phone' ? <Phone className="w-3 h-3" /> : <MessageCircle className="w-3 h-3" />}
                    {c.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <PdConsentCheckbox checked={consent} onChange={setConsent} />
            {error && <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>}
            <button type="submit" disabled={sending} className="ds-btn ds-btn-primary w-full inline-flex items-center justify-center gap-2">
              {sending && <Loader2 className="w-4 h-4 animate-spin" />}
              Отправить запрос оператору
            </button>
            <p className="text-xs text-[var(--text-muted)]">
              Оператор ответит в течение 2 часов. Если места есть — бронь заводится и подтверждается сразу, оплата после подтверждения.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
