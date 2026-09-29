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
 * Для этих двух каналов ссылка на страницу статуса — ЕДИНСТВЕННЫЙ путь к
 * ответу, поэтому она копируется кнопкой и подписана как единственная.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, X, Send, MessageCircle, Phone, ExternalLink, Copy, Check } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { agentReferralForBooking } from '@/lib/referral/agent-link';

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
  // Строка, а не число: поле можно стереть и набрать заново; «пустое» не
  // превращается в 1 на лету (обзор 29.09).
  const [participants, setParticipants] = useState(String(Math.max(1, defaultParticipants)));
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState<ReplyChannel>('max');
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingUrl, setExistingUrl] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Сегодня по Камчатке (UTC+12) — нижняя граница выбора даты.
  const [today] = useState(() => new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 10));

  // Диалог: фокус внутрь при открытии и Escape для закрытия. Фокус
  // возвращается на кнопку, которая окно открыла. onClose приходит новой
  // функцией на каждом рендере родителя, поэтому лежит в ref: в зависимостях
  // эффекта он возвращал бы фокус в диалог при каждом нажатии клавиши.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);

  const count = Number(participants);
  const countValid = Number.isInteger(count) && count >= 1 && count <= 100;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setExistingUrl(null);
    if (!countValid) { setError('Укажите число человек от 1 до 100'); return; }
    if (!consent) { setError('Нужно согласие на обработку персональных данных'); return; }
    setSending(true);
    try {
      const res = await fetch('/api/seat-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tour_id: tour.id, date, participants: count,
          tourist_name: name, tourist_phone: phone,
          reply_channel: channel, pd_consent: consent,
          referral_code: agentReferralForBooking(window.location.search, Date.now()) ?? undefined,
        }),
      });
      const body = await res.json().catch(() => null) as
        | { success: true; data: Created }
        | { success: false; error?: string; status_url?: string }
        | null;
      if (!res.ok || !body || !body.success) {
        setError((body && !body.success && body.error) || `Сервер ответил ${res.status}`);
        if (body && !body.success && body.status_url) setExistingUrl(body.status_url);
        return;
      }
      setCreated(body.data);
    } catch {
      setError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    } finally {
      setSending(false);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Буфер недоступен — ссылка показана текстом ниже, её можно выделить.
      setError('Не удалось скопировать — выделите ссылку вручную.');
    }
  }

  const deadline = created
    ? new Date(created.deadline_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : '';
  const onlyLink = channel === 'whatsapp' || channel === 'phone';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      role="presentation"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="seat-request-title"
        className="ds-card w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-lg sm:rounded-lg p-5 space-y-4 outline-none"
      >
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
            <div className="space-y-1.5">
              {onlyLink && (
                <p className="text-sm font-semibold text-[var(--warning)]">
                  Сохраните ссылку — это единственный способ увидеть ответ.
                </p>
              )}
              <input readOnly value={created.status_url} onFocus={e => e.currentTarget.select()} className="ds-input w-full text-xs font-mono" aria-label="Ссылка на страницу запроса" />
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => copyLink(created.status_url)} className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-1.5">
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Скопировано' : 'Скопировать'}
                </button>
                <a href={created.status_url} target="_blank" rel="noopener noreferrer" className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-1.5">
                  <ExternalLink className="w-4 h-4" />
                  Открыть
                </a>
              </div>
              {error && <p className="text-xs text-[var(--danger)]" role="alert">{error}</p>}
            </div>
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
                <input type="number" inputMode="numeric" required min={1} max={100} value={participants}
                       onChange={e => setParticipants(e.target.value)} className="ds-input w-full" />
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
            {error && (
              <div className="text-sm text-[var(--danger)] space-y-1" role="alert">
                <p>{error}</p>
                {existingUrl && (
                  <a href={existingUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] hover:underline">
                    Открыть отправленный запрос
                  </a>
                )}
              </div>
            )}
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
