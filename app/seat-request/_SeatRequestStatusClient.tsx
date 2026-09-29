'use client';

/**
 * Страница статуса запроса мест для туриста (29.09). Ключ запроса — во
 * фрагменте адреса (`/seat-request#<ключ>`), а не в пути. Работает всегда —
 * даже если мессенджер не подключён: ответ оператора виден здесь. Пока запрос
 * ждёт, страница сама переспрашивает статус раз в 30 секунд; если самая первая
 * загрузка не удалась, повторяет её, а не застывает на ошибке.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, CheckCircle2, XCircle, CalendarClock, Clock, AlertTriangle, Send } from 'lucide-react';

type Status = 'pending' | 'confirmed' | 'declined' | 'other_date' | 'expired' | 'failed';

interface View {
  status: Status;
  tourId: string;
  tourTitle: string;
  date: string;
  participants: number;
  altDate: string | null;
  deadlineAt: string;
  replyChannel: 'telegram' | 'max' | 'whatsapp' | 'phone';
  touristChatBound: boolean;
  touristNotified: boolean;
  bookingUrl: string | null;
  botLinks: { telegram: string; max: string };
}

const TEXT: Record<Status, { title: string; tone: string }> = {
  pending:    { title: 'Ждём ответа оператора', tone: 'var(--ocean)' },
  confirmed:  { title: 'Места есть — бронь подтверждена', tone: 'var(--success)' },
  declined:   { title: 'На эту дату мест нет', tone: 'var(--text-secondary)' },
  other_date: { title: 'Оператор предлагает другую дату', tone: 'var(--warning)' },
  expired:    { title: 'Оператор не ответил за 2 часа', tone: 'var(--warning)' },
  failed:     { title: 'Бронь автоматически не завелась', tone: 'var(--danger)' },
};

function Icon({ s }: { s: Status }) {
  const cls = 'w-6 h-6 shrink-0';
  const style = { color: TEXT[s].tone };
  if (s === 'pending') return <Clock className={cls} style={style} />;
  if (s === 'confirmed') return <CheckCircle2 className={cls} style={style} />;
  if (s === 'declined') return <XCircle className={cls} style={style} />;
  if (s === 'other_date') return <CalendarClock className={cls} style={style} />;
  return <AlertTriangle className={cls} style={style} />;
}

const KEY_RE = /^[A-Za-z0-9_-]{32}$/;

export function SeatRequestStatusClient() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ключ читается из фрагмента после монтирования: на сервере его нет по
  // построению. undefined — ещё не читали, null — в адресе ключа нет.
  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, '');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- чтение адреса браузера, источника до монтирования нет
    setToken(KEY_RE.test(raw) ? raw : null);
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/seat-requests/status?t=${encodeURIComponent(token)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null) as { success: true; data: View } | { success: false; error?: string } | null;
      if (!res.ok || !body || !body.success) {
        setError((body && !body.success && body.error) || `Сервер ответил ${res.status}`);
        return;
      }
      setError(null);
      setView(body.data);
    } catch {
      setError('Нет связи с сервером.');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Пока запрос ждёт — переспрашиваем. Пока первая загрузка не удалась
  // (view нет, ошибка есть) — тоже: иначе один сбой сети оставлял страницу
  // навсегда на ошибке, хотя запрос жив.
  useEffect(() => {
    const keepPolling = view?.status === 'pending' || (view === null && error !== null);
    if (!token || !keepPolling) return;
    const t = setInterval(() => { void load(); }, view === null ? 10_000 : 30_000);
    return () => clearInterval(t);
  }, [token, view, error, load]);

  if (token === undefined) {
    return <main className="ds-page min-h-screen" />;
  }

  return (
    <main className="ds-page min-h-screen px-4 py-10">
      <div className="max-w-md mx-auto space-y-4">
        {token === null && (
          <div className="ds-card p-6 space-y-2">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>Ссылка не полная</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              В адресе нет ключа запроса. Откройте ссылку целиком — ту, что показали после отправки запроса или прислали в мессенджер.
            </p>
            <Link href="/planner" className="text-sm text-[var(--ocean)] hover:underline">К планеру</Link>
          </div>
        )}
        {token !== null && !view && !error && (
          <div className="ds-card p-6 flex items-center gap-2 text-[var(--text-secondary)]">
            <Loader2 className="w-4 h-4 animate-spin" /> Проверяем статус…
          </div>
        )}
        {error && (
          <p className="text-sm text-[var(--danger)]" role="alert">
            {view ? `${error} Показан последний известный статус.` : `${error} Пробуем ещё раз…`}
          </p>
        )}
        {view && (
          <div className="ds-card p-6 space-y-4" aria-live="polite">
            <div className="flex items-start gap-3">
              <Icon s={view.status} />
              <div>
                <h1 className="text-2xl font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
                  {TEXT[view.status].title}
                </h1>
                <p className="text-sm text-[var(--text-secondary)] mt-1">
                  {view.tourTitle} · {view.date} · {view.participants} чел.
                </p>
              </div>
            </div>

            {view.status === 'pending' && (
              <p className="text-sm text-[var(--text-secondary)]">
                Оператор ответит до {new Date(view.deadlineAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.
                Если места есть, бронь заведётся и подтвердится сразу.
              </p>
            )}
            {view.status === 'confirmed' && (
              view.bookingUrl
                ? <a href={view.bookingUrl} className="ds-btn ds-btn-primary w-full inline-flex justify-center">Открыть бронь и оплатить</a>
                : <p className="text-sm text-[var(--text-secondary)]">
                    Бронь подтверждена.{' '}
                    {view.touristNotified
                      ? 'Ссылку на оплату мы прислали в мессенджер.'
                      : 'Ссылку на оплату мы отдельно не отправляли — оператор свяжется с вами по указанному телефону.'}
                  </p>
            )}
            {view.status === 'other_date' && view.altDate && (
              <p className="text-sm text-[var(--text-primary)]">Предложенная дата: <b>{view.altDate}</b>. Если подходит — отправьте запрос на неё из планера или откройте тур.</p>
            )}
            {view.status === 'expired' && (
              <p className="text-sm text-[var(--text-secondary)]">Это не значит, что мест нет: оператор мог быть без связи. Отправьте запрос ещё раз или оставьте заявку — менеджер свяжется с оператором.</p>
            )}
            {view.status === 'failed' && (
              <p className="text-sm text-[var(--text-secondary)]">Оператор ответил, что места есть, но наш учёт не дал завести бронь. Мы разбираемся и свяжемся с вами.</p>
            )}

            {!view.touristChatBound && view.status === 'pending' && (
              <div className="space-y-2 pt-2 border-t border-[var(--border)]">
                <p className="text-sm text-[var(--text-secondary)]">Получить ответ в мессенджер — откройте бота и нажмите «Старт»:</p>
                <div className="grid grid-cols-2 gap-2">
                  <a href={view.botLinks.max} target="_blank" rel="noopener noreferrer" className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-1.5"><Send className="w-4 h-4" />MAX</a>
                  <a href={view.botLinks.telegram} target="_blank" rel="noopener noreferrer" className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-1.5"><Send className="w-4 h-4" />Telegram</a>
                </div>
              </div>
            )}

            <div className="flex gap-3 text-sm">
              <Link href={`/catalog/tours/${view.tourId}`} className="text-[var(--ocean)] hover:underline">Карточка тура</Link>
              <Link href="/planner" className="text-[var(--ocean)] hover:underline">Планер</Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
