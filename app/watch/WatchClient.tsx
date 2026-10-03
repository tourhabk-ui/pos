'use client';

/**
 * /watch?id=… — страница экстренного контакта: где турист был последний раз
 * и что с его контролем выхода. Правила показа — lib/safety/watch-status.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle, Clock, Copy, Loader2, MapPin, RefreshCw, TriangleAlert } from 'lucide-react';
import LeaderPhoneField from '@/components/safety/LeaderPhoneField';
import { formatKamchatkaTime } from '@/lib/safety/checkin-escalation';
import { positionSourceLabel, type WatchView } from '@/lib/safety/watch-status';

const REFRESH_MS = 60_000;
const PHONE_KEY = 'watch_leader_phone';

function kt(isoStr: string | null): string {
  return isoStr ? formatKamchatkaTime(new Date(isoStr)) : '—';
}

const STATE_TEXT: Record<WatchView['state'], { title: string; tone: 'ok' | 'wait' | 'alarm' | 'muted' }> = {
  returned: { title: 'Вернулся — контроль закрыт', tone: 'ok' },
  cancelled: { title: 'Контроль отменён', tone: 'muted' },
  closed: { title: 'Контроль закрыт', tone: 'muted' },
  no_deadline: { title: 'На маршруте, срок возвращения не задан', tone: 'wait' },
  on_route: { title: 'На маршруте, срок ещё не наступил', tone: 'wait' },
  overdue: { title: 'Срок возвращения прошёл', tone: 'alarm' },
};

const TONE_COLOR = { ok: 'var(--success)', wait: 'var(--ocean)', alarm: 'var(--danger)', muted: 'var(--text-secondary)' };

export default function WatchClient() {
  const registrationId = useSearchParams().get('id');
  const [phone, setPhone] = useState('');
  const [watch, setWatch] = useState<WatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const phoneRef = useRef('');

  const load = useCallback(async (leaderPhone: string) => {
    if (!registrationId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/safety/watch-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registration_id: registrationId,
          ...(leaderPhone.trim() ? { leader_phone: leaderPhone.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setWatch(data.watch as WatchView);
        setError(null);
        setCheckedAt(new Date());
        phoneRef.current = leaderPhone;
        try { sessionStorage.setItem(PHONE_KEY, leaderPhone); } catch { /* приватный режим */ }
      } else if (data.reason === 'not_found') {
        setNotFound(true);
      } else if (data.reason === 'phone_required') {
        setError(null);
      } else {
        setError(data.error || 'Не удалось получить состояние');
      }
    } catch {
      // Сеть: показанное остаётся, но с честной пометкой, когда проверяли.
      setError('Сеть недоступна — показано последнее полученное состояние.');
    } finally {
      setLoading(false);
    }
  }, [registrationId]);

  // Номер в рамках вкладки: обновление страницы не должно снова его спрашивать.
  useEffect(() => {
    let saved = '';
    try { saved = sessionStorage.getItem(PHONE_KEY) ?? ''; } catch { /* приватный режим */ }
    setPhone(saved);
    void load(saved);
  }, [load]);

  // Пока контроль открыт — обновляем раз в минуту.
  const open = watch != null && (watch.state === 'on_route' || watch.state === 'overdue' || watch.state === 'no_deadline');
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => { void load(phoneRef.current); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [open, load]);

  const shell = (children: React.ReactNode) => (
    <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <div className="max-w-lg mx-auto px-4 py-8 space-y-5">{children}</div>
    </div>
  );

  if (!registrationId || notFound) {
    return shell(
      <div className="text-center space-y-3 pt-12">
        <TriangleAlert className="w-12 h-12 mx-auto text-[var(--warning)]" />
        <h1 className="font-playfair text-2xl font-bold">Контроль не найден</h1>
        <p className="text-[var(--text-secondary)]">
          Откройте страницу по ссылке из сообщения Ведара — в ней номер контроля.
        </p>
      </div>,
    );
  }

  if (!watch) {
    return shell(
      <>
        <h1 className="font-playfair text-2xl font-bold">Контроль выхода</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Здесь видно, где турист был последний раз и что с его контролем выхода.
          Точка — личные данные, поэтому нужен номер телефона руководителя группы.
        </p>
        <LeaderPhoneField value={phone} onChange={setPhone} disabled={loading} error={error} />
        <button
          onClick={() => void load(phone)}
          disabled={loading || !phone.trim()}
          className="ds-btn ds-btn-primary w-full justify-center disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Показать'}
        </button>
      </>,
    );
  }

  const st = STATE_TEXT[watch.state];
  const coords = watch.position
    ? `${watch.position.lat.toFixed(5)}, ${watch.position.lng.toFixed(5)}`
    : null;

  const copy = async () => {
    if (!coords) return;
    try {
      await navigator.clipboard.writeText(coords);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* выделит руками: координаты крупно на экране */ }
  };

  return shell(
    <>
      <div>
        <p className="text-xs text-[var(--text-muted)]">Контроль выхода · {watch.routeName}</p>
        <h1 className="font-playfair text-2xl font-bold mt-1" style={{ color: TONE_COLOR[st.tone] }}>{st.title}</h1>
      </div>

      <div className="ds-card p-4 space-y-2 text-sm">
        <p>
          <Clock className="w-4 h-4 inline -mt-0.5 mr-1.5 text-[var(--text-muted)]" />
          <span className="text-[var(--text-muted)]">Срок возвращения:</span>{' '}
          <span className="tabular-nums">{watch.expectedReturnAt ? kt(watch.expectedReturnAt) : 'не задан'}</span>
        </p>
        {watch.closedAt && (
          <p><span className="text-[var(--text-muted)]">Закрыт:</span> <span className="tabular-nums">{kt(watch.closedAt)}</span></p>
        )}
        {!watch.closedAt && (
          <p>
            <span className="text-[var(--text-muted)]">Отметка «всё в порядке»:</span>{' '}
            {watch.checkinConfirmedAt ? <span className="tabular-nums">{kt(watch.checkinConfirmedAt)}</span> : 'не отмечался'}
          </p>
        )}
        {watch.mchsInformedAt && (
          <p><span className="text-[var(--text-muted)]">В МЧС сообщили:</span> <span className="tabular-nums">{kt(watch.mchsInformedAt)}</span></p>
        )}
      </div>

      {!watch.closedAt && (
        <div className="ds-card p-4 space-y-2">
          <p className="ds-label flex items-center gap-1.5"><MapPin className="w-4 h-4" /> Последняя точка</p>
          {coords && watch.position ? (
            <>
              <p className="text-2xl font-bold tabular-nums select-all">{coords}</p>
              <p className="text-sm text-[var(--text-secondary)]">
                {watch.position.at ? kt(watch.position.at) : 'время не записано'}
                {' · '}{positionSourceLabel(watch.position.source)}
              </p>
              <button onClick={() => void copy()} className="ds-btn ds-btn-secondary text-sm">
                <Copy className="w-4 h-4" /> {copied ? 'Скопировано' : 'Скопировать координаты'}
              </button>
            </>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">
              Последняя точка неизвестна: телефон и трекер туриста не присылали координат.
            </p>
          )}
        </div>
      )}

      {watch.state === 'overdue' && (
        <div className="rounded-lg p-4 space-y-3 border" style={{ borderColor: 'var(--danger)' }}>
          <p className="text-sm">
            Сначала позвоните туристу. Не отвечает — звоните в <strong>112</strong> и назовите маршрут,
            срок и последнюю точку с её временем.
          </p>
          <div className="flex flex-col gap-2">
            <Link href={`/checkin-ok?id=${registrationId}`} className="ds-btn ds-btn-secondary justify-center">
              Группа на связи, задерживается
            </Link>
            <Link href={`/return?id=${registrationId}`} className="ds-btn ds-btn-secondary justify-center">
              <CheckCircle className="w-4 h-4" /> Группа вернулась
            </Link>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span className="tabular-nums">
          {checkedAt ? `Проверено ${checkedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ''}
          {open ? ' · обновляется раз в минуту' : ''}
        </span>
        <button onClick={() => void load(phoneRef.current)} disabled={loading} className="flex items-center gap-1 hover:text-[var(--text-primary)]">
          <RefreshCw className={`w-3.5 h-3.5${loading ? ' animate-spin' : ''}`} /> Обновить
        </button>
      </div>
      {error && <p className="text-sm text-[var(--warning)]">{error}</p>}
    </>,
  );
}
