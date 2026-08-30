'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle, RefreshCw, Copy, Check } from 'lucide-react';

interface SbpQrPaymentProps {
  bookingId: number;
  amount: number;
  onPaid: () => void;
}

interface QrData {
  qrCode: string;
  qrLink: string;
  payload: string;
  expiresAt: string;
}

type Phase = 'loading' | 'showing' | 'expired' | 'unavailable' | 'error' | 'already_started';

function formatCountdown(msLeft: number): string {
  const totalSec = Math.max(0, Math.floor(msLeft / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Оплата брони через QR СБП (Точка). Второй способ оплаты рядом с картой на
 * /booking-success — раньше QR был доступен только из чата Кузьмича
 * (см. §7 CLAUDE.md), обычный чек-аут показывал только CloudPayments.
 *
 * Третье состояние — по правилу §4.0: 503 (СБП не настроен) не рисуется
 * ошибкой поверх формы, компонент сообщает об этом и предлагает
 * вернуться к оплате картой, а не оставляет пользователя перед сломанной
 * кнопкой.
 */
export default function SbpQrPayment({ bookingId, amount, onPaid }: SbpQrPaymentProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [qr, setQr] = useState<QrData | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [msLeft, setMsLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const requestQr = async () => {
    setPhase('loading');
    setErrorMsg('');
    try {
      const res = await fetch('/api/payments/tochka/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId }),
      });
      const data: unknown = await res.json();
      const obj = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;

      if (res.status === 503) {
        setPhase('unavailable');
        return;
      }
      if (res.status === 409) {
        // QR уже выпускался раньше — повторно получить его нельзя, но
        // проверять оплату по этой брони можно и без него.
        setPhase('already_started');
        return;
      }
      if (!res.ok) {
        setErrorMsg(typeof obj.error === 'string' ? obj.error : 'Не удалось создать QR-код оплаты');
        setPhase('error');
        return;
      }

      setQr({
        qrCode: String(obj.qrCode ?? ''),
        qrLink: String(obj.qrLink ?? ''),
        payload: String(obj.payload ?? ''),
        expiresAt: String(obj.expiresAt ?? ''),
      });
      setPhase('showing');
    } catch {
      setErrorMsg('Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.');
      setPhase('error');
    }
  };

  useEffect(() => {
    void requestQr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  // Обратный отсчёт до истечения QR
  useEffect(() => {
    if (phase !== 'showing' || !qr) return;
    const expiry = new Date(qr.expiresAt).getTime();
    const tick = () => {
      const left = expiry - Date.now();
      setMsLeft(left);
      if (left <= 0) setPhase('expired');
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase, qr]);

  // Опрос статуса оплаты — пока QR показан или уже выпускался ранее
  useEffect(() => {
    if (phase !== 'showing' && phase !== 'already_started') return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/payments/tochka/qr?bookingId=${bookingId}`);
        const json = await res.json() as { paid?: boolean };
        if (json.paid) {
          if (pollRef.current) clearInterval(pollRef.current);
          onPaid();
        }
      } catch { /* следующий тик попробует снова */ }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [phase, bookingId, onPaid]);

  const handleCopyPayload = () => {
    if (!qr) return;
    void navigator.clipboard.writeText(qr.payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (phase === 'loading') {
    return (
      <div className="flex flex-col items-center gap-2 py-8">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
        <p className="text-xs text-[var(--text-muted)]">Готовим QR-код…</p>
      </div>
    );
  }

  if (phase === 'unavailable') {
    return (
      <div className="flex items-start gap-2 px-4 py-3 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)]">
        <AlertCircle className="w-4 h-4 shrink-0 text-[var(--text-secondary)] mt-0.5" />
        <p className="text-sm text-[var(--text-secondary)]">
          Оплата по СБП сейчас недоступна. Оплатите картой — это тот же тур по той же цене.
        </p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg border border-[var(--danger)] bg-[var(--danger)] bg-opacity-10">
          <AlertCircle className="w-4 h-4 shrink-0 text-[var(--danger)] mt-0.5" />
          <p className="text-sm text-[var(--danger)]">{errorMsg}</p>
        </div>
        <button
          onClick={() => void requestQr()}
          className="ds-btn ds-btn-secondary w-full flex items-center justify-center gap-2 text-sm"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Попробовать снова
        </button>
      </div>
    );
  }

  if (phase === 'already_started') {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
        <p className="text-sm text-[var(--text-primary)]">
          Оплата по СБП для этой брони уже запрошена ранее.
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          Если QR-код у вас ещё открыт в банковском приложении — завершите оплату там.
          Мы проверяем статус автоматически и обновим страницу сами.
        </p>
      </div>
    );
  }

  if (phase === 'expired') {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <p className="text-sm text-[var(--text-primary)]">Время действия QR-кода истекло</p>
        <button
          onClick={() => void requestQr()}
          className="ds-btn ds-btn-primary flex items-center justify-center gap-2 text-sm px-5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Получить новый QR
        </button>
      </div>
    );
  }

  // phase === 'showing'
  if (!qr) return null;
  return (
    <div className="flex flex-col items-center gap-3 py-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`data:image/png;base64,${qr.qrCode}`}
        alt="QR-код для оплаты через СБП"
        width={192}
        height={192}
        className="w-48 h-48 rounded-lg border border-[var(--border)]"
      />
      <p className="text-2xl font-bold text-[var(--text-primary)]">
        {amount.toLocaleString('ru-RU')} ₽
      </p>
      <p className="text-xs text-[var(--text-muted)]">
        Отсканируйте QR камерой банковского приложения или откройте по кнопке ниже
      </p>

      <a
        href={qr.qrLink}
        className="ds-btn ds-btn-primary w-full flex items-center justify-center gap-2 text-sm py-2.5"
      >
        Открыть в приложении банка
      </a>

      <button
        onClick={handleCopyPayload}
        className="flex items-center gap-1.5 text-xs text-[var(--ocean)] hover:text-[var(--accent)] transition-colors"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? 'Скопировано' : 'Скопировать данные для оплаты'}
      </button>

      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] pt-1">
        <Loader2 className="w-3 h-3 animate-spin" />
        Ожидаем оплату… QR действителен ещё {formatCountdown(msLeft)}
      </div>
    </div>
  );
}
