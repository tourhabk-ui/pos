'use client';

/**
 * «Мессенджеры администратора» на обзоре админки.
 *
 * MAX — слово владельца 23.10 («1а»). Telegram — 24.10: «нет привязки админа
 * к Telegram». 24.10 же: блок плоский, рядом нет Telegram — две равные плитки,
 * у каждой одна кнопка. После неё — QR, ссылка, «Скопировать» и одна строка,
 * как открыть. Длинный текст о правах — в «Что умеет бот».
 *
 * Знаки — опубликованные марки мессенджеров, не иконки интерфейса: форма MAX
 * из знака max.ru, самолётик Telegram 2019. Их цвета — цвета марок, не палитра
 * Ведара. Состояние, которое не прочиталось, так и названо (§4.0).
 */

import React, { useEffect, useState } from 'react';
import { Check, Copy, Loader2, AlertTriangle, ChevronDown } from 'lucide-react';

type Status =
  | { kind: 'loading' }
  | { kind: 'bound'; boundAt: string | null }
  | { kind: 'unbound' }
  | { kind: 'failed'; error: string };

type Link =
  | { kind: 'none' }
  | { kind: 'issuing' }
  | { kind: 'ready'; link: string; expiresAt: string; botUnverified: string | null }
  | { kind: 'error'; error: string };

interface MessengerSpec {
  id: 'max' | 'telegram';
  title: string;
  endpoint: string;
  connectLabel: string;
  againLabel: string;
  hint: string;
  qrAlt: string;
  unbindQuestion: string;
  ability: string;
  Mark: () => React.ReactElement;
}

/** Время по Камчатке; дата, которую браузер не разобрал, — пустая строка, а не «Invalid Date». */
function kamchatkaTime(iso: string, withDate: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    timeZone: 'Asia/Kamchatka',
    ...(withDate ? { day: 'numeric', month: 'long' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

function MaxMark() {
  return (
    <svg viewBox="0 0 42 42" className="w-10 h-10 shrink-0" aria-hidden>
      <linearGradient id="vedar-max-mark" x1="2" y1="2" x2="40" y2="40">
        <stop offset="0" stopColor="#471AFF" />
        <stop offset="1" stopColor="#00BFFF" />
      </linearGradient>
      <path
        fill="url(#vedar-max-mark)"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.47 41.88c-4.11 0-6.02-.6-9.34-3-2.1 2.7-8.75 4.81-9.04 1.2 0-2.71-.6-5-1.28-7.5C1 29.5.08 26.07.08 21.1.08 9.23 9.82.3 21.36.3c11.55 0 20.6 9.37 20.6 20.91a20.6 20.6 0 0 1-20.49 20.67m.17-31.32c-5.62-.29-10 3.6-10.97 9.7-.8 5.05.62 11.2 1.83 11.52.58.14 2.04-1.04 2.95-1.95a10.4 10.4 0 0 0 5.08 1.81 10.7 10.7 0 0 0 11.19-9.97 10.7 10.7 0 0 0-10.08-11.1Z"
      />
    </svg>
  );
}

function TelegramMark() {
  return (
    <svg viewBox="0 0 240.1 240.1" className="w-10 h-10 shrink-0" aria-hidden>
      <linearGradient id="vedar-tg-mark" gradientUnits="userSpaceOnUse" x1="-838.041" y1="660.581" x2="-838.041" y2="660.3427" gradientTransform="matrix(1000 0 0 -1000 838161 660581)">
        <stop offset="0" stopColor="#2AABEE" />
        <stop offset="1" stopColor="#229ED9" />
      </linearGradient>
      <circle fillRule="evenodd" clipRule="evenodd" fill="url(#vedar-tg-mark)" cx="120.1" cy="120.1" r="120.1" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="#FFFFFF"
        d="M54.3,118.8c35-15.2,58.3-25.3,70-30.2 c33.3-13.9,40.3-16.3,44.8-16.4c1,0,3.2,0.2,4.7,1.4c1.2,1,1.5,2.3,1.7,3.3s0.4,3.1,0.2,4.7c-1.8,19-9.6,65.1-13.6,86.3 c-1.7,9-5,12-8.2,12.3c-7,0.6-12.3-4.6-19-9c-10.6-6.9-16.5-11.2-26.8-18c-11.9-7.8-4.2-12.1,2.6-19.1c1.8-1.8,32.5-29.8,33.1-32.3 c0.1-0.3,0.1-1.5-0.6-2.1c-0.7-0.6-1.7-0.4-2.5-0.2c-1.1,0.2-17.9,11.4-50.6,33.5c-4.8,3.3-9.1,4.9-13,4.8 c-4.3-0.1-12.5-2.4-18.7-4.4c-7.5-2.4-13.5-3.7-13-7.9C45.7,123.3,48.7,121.1,54.3,118.8z"
      />
    </svg>
  );
}

const MESSENGERS: MessengerSpec[] = [
  {
    id: 'max',
    title: 'MAX',
    endpoint: '/api/admin/max-link',
    connectLabel: 'Подключить',
    againLabel: 'Подключить заново',
    hint: 'Откройте в MAX и нажмите Старт',
    qrAlt: 'QR-код: откройте в MAX и нажмите Старт',
    unbindQuestion: 'Отключить MAX администратора?',
    ability: 'В личном чате бот узнаёт вас как администратора: открытые даты, брони, заявки, сводка суток и здоровье сторожей. Права проверяются на каждом сообщении — снимут роль на сайте, снимутся и здесь. Ссылка живёт 10 минут. Никому её не пересылайте: кто нажмёт «Старт», тот и станет администратором в чате.',
    Mark: MaxMark,
  },
  {
    id: 'telegram',
    title: 'Telegram',
    endpoint: '/api/admin/telegram-link',
    connectLabel: 'Подключить',
    againLabel: 'Подключить заново',
    hint: 'Откройте в Telegram и нажмите Старт',
    qrAlt: 'QR-код: откройте в Telegram и нажмите Старт',
    unbindQuestion: 'Отключить Telegram администратора?',
    ability: 'Те же кнопки, что в MAX: даты, брони, заявки, сводка и здоровье сторожей. Контакты туристов здесь не показываются — они остаются в MAX. Права проверяются на каждом сообщении. Ссылка живёт 10 минут. Никому её не пересылайте: кто нажмёт «Старт», тот и станет администратором в чате.',
    Mark: TelegramMark,
  },
];

async function readJson(res: Response): Promise<{ success?: boolean; error?: unknown; data?: Record<string, unknown> } | null> {
  return res.json().catch(() => null) as Promise<{ success?: boolean; error?: unknown; data?: Record<string, unknown> } | null>;
}

async function readStatus(endpoint: string): Promise<Status> {
  try {
    const res = await fetch(endpoint, { cache: 'no-store' });
    const body = await readJson(res);
    if (!res.ok || !body?.success || !body.data) {
      return { kind: 'failed', error: typeof body?.error === 'string' ? body.error : `Сервер ответил ${res.status}` };
    }
    const boundAt = typeof body.data.bound_at === 'string' ? body.data.bound_at : null;
    return body.data.bound === true ? { kind: 'bound', boundAt } : { kind: 'unbound' };
  } catch {
    return { kind: 'failed', error: 'Нет связи с сервером' };
  }
}

function StatusBadge({ status }: { status: Status }) {
  if (status.kind === 'loading') {
    return <span className="ds-badge bg-[var(--bg-hover)] text-[var(--text-muted)]">загрузка</span>;
  }
  if (status.kind === 'bound') {
    const when = status.boundAt ? kamchatkaTime(status.boundAt, true) : '';
    return (
      <span className="inline-flex flex-col items-end gap-0.5">
        <span className="ds-badge bg-[var(--success)]/15 text-[var(--success)]">подключён</span>
        {when ? <span className="text-[11px] text-[var(--text-muted)]">{when}</span> : null}
      </span>
    );
  }
  if (status.kind === 'failed') {
    return (
      <span className="ds-badge bg-[var(--warning)]/15 text-[var(--warning)]">
        <AlertTriangle className="w-3 h-3 mr-1" aria-hidden />
        не загрузилось
      </span>
    );
  }
  return <span className="ds-badge bg-[var(--bg-hover)] text-[var(--text-secondary)]">не подключён</span>;
}

function MessengerTile({ spec }: { spec: MessengerSpec }) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [link, setLink] = useState<Link>({ kind: 'none' });
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [unbindError, setUnbindError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string | 'failed' | null>(null);
  const titleId = `admin-messenger-${spec.id}`;
  const Mark = spec.Mark;
  const readyLink = link.kind === 'ready' ? link.link : null;
  const qr = qrFor === readyLink ? qrSvg : null;

  useEffect(() => {
    let alive = true;
    readStatus(spec.endpoint).then((next) => { if (alive) setStatus(next); });
    return () => { alive = false; };
  }, [spec.endpoint]);

  useEffect(() => {
    if (!readyLink) return;
    let alive = true;
    const target = readyLink;
    import('qrcode')
      .then((QR) => QR.toString(target, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#1A1A1A', light: '#FFFFFF' },
      }))
      .then((svg) => {
        if (!alive) return;
        if (typeof svg !== 'string' || !svg.startsWith('<svg') || /<script/i.test(svg)) {
          setQrFor(target);
          setQrSvg('failed');
          return;
        }
        setQrFor(target);
        setQrSvg(svg);
      })
      .catch((err: unknown) => {
        console.error('[admin/messengers] QR не собран', err instanceof Error ? err.message : 'нет текста');
        if (!alive) return;
        setQrFor(target);
        setQrSvg('failed');
      });
    return () => { alive = false; };
  }, [readyLink]);

  async function issue() {
    setLink({ kind: 'issuing' });
    setCopied(false);
    setCopyError(null);
    try {
      const res = await fetch(spec.endpoint, { method: 'POST' });
      const body = await readJson(res);
      const data = body?.data;
      if (!res.ok || !body?.success || typeof data?.link !== 'string' || typeof data.expires_at !== 'string') {
        setLink({ kind: 'error', error: typeof body?.error === 'string' ? body.error : `Сервер ответил ${res.status}` });
        return;
      }
      const botUnverified = spec.id !== 'telegram' || data.bot_source === 'getMe'
        ? null
        : (typeof data.bot_reason === 'string' && data.bot_reason.length > 0
          ? data.bot_reason
          : 'Telegram не подтвердил имя бота');
      setLink({ kind: 'ready', link: data.link, expiresAt: data.expires_at, botUnverified });
    } catch {
      setLink({ kind: 'error', error: 'Нет связи с сервером' });
    }
  }

  async function unbind() {
    setUnbinding(true);
    setUnbindError(null);
    try {
      const res = await fetch(spec.endpoint, { method: 'DELETE' });
      const body = await readJson(res);
      if (!res.ok || !body?.success) {
        setUnbindError(typeof body?.error === 'string' ? body.error : `Сервер ответил ${res.status}`);
        return;
      }
      setConfirmUnbind(false);
      setLink({ kind: 'none' });
      setStatus({ kind: 'unbound' });
    } catch {
      setUnbindError('Нет связи с сервером');
    } finally {
      setUnbinding(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('Не удалось скопировать — выделите ссылку вручную.');
    }
  }

  const until = link.kind === 'ready' ? kamchatkaTime(link.expiresAt, false) : '';
  const hint = until ? `${spec.hint} — до ${until}.` : `${spec.hint}.`;

  return (
    <div role="group" aria-labelledby={titleId} className="ds-card flex flex-col gap-3 p-4 min-w-0">
      <div className="flex items-start gap-3">
        <Mark />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-semibold text-[var(--text-primary)] leading-tight">{spec.title}</h3>
        </div>
        <StatusBadge status={status} />
      </div>

      {status.kind === 'failed' && (
        <p className="text-xs text-[var(--text-secondary)]">не загрузилось: {status.error}</p>
      )}

      <button
        type="button"
        onClick={issue}
        disabled={link.kind === 'issuing' || status.kind === 'loading'}
        className="ds-btn ds-btn-primary w-full"
      >
        {link.kind === 'issuing'
          ? <Loader2 className="w-4 h-4 animate-spin" aria-label="Выдаю ссылку" />
          : status.kind === 'bound' ? spec.againLabel : spec.connectLabel}
      </button>

      {status.kind === 'bound' && !confirmUnbind && (
        <button
          type="button"
          onClick={() => setConfirmUnbind(true)}
          className="self-start text-xs text-[var(--danger)] underline underline-offset-2 min-h-11 px-0.5"
        >
          Отключить
        </button>
      )}
      {status.kind === 'bound' && confirmUnbind && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3 space-y-2">
          <p className="text-xs text-[var(--text-secondary)]">{spec.unbindQuestion}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={unbind} disabled={unbinding} className="ds-btn ds-btn-danger text-xs">
              {unbinding ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="Отключаю" /> : 'Да, отключить'}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmUnbind(false); setUnbindError(null); }}
              className="ds-btn ds-btn-secondary text-xs"
            >
              Нет
            </button>
          </div>
        </div>
      )}
      {status.kind === 'bound' && unbindError && (
        <p className="text-xs text-[var(--danger)]" role="alert">
          Не отключено: {unbindError}. {spec.title} администратора всё ещё подключён — нажмите «Да, отключить» ещё раз.
        </p>
      )}

      {link.kind === 'error' && <p className="text-xs text-[var(--danger)]" role="alert">{link.error}</p>}

      {link.kind === 'ready' && (
        <div className="space-y-2">
          <div className="flex justify-center">
            {qr === 'failed' ? (
              <p className="text-xs text-[var(--text-secondary)]" role="status">QR не собрался. Откройте ссылку или скопируйте её.</p>
            ) : qr ? (
              // QR — data URL, собранный в браузере. next/image отправил бы его в оптимизатор и испортил клетки.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt={spec.qrAlt}
                width={168}
                height={168}
                className="rounded-md border border-[var(--border)]"
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`}
              />
            ) : (
              <span className="text-xs text-[var(--text-muted)]" aria-live="polite">Собираю QR</span>
            )}
          </div>
          <p className="text-sm text-center text-[var(--text-primary)]">{hint}</p>
          {link.botUnverified && (
            <p className="text-xs text-[var(--text-secondary)]" role="status">
              Имя бота не проверено у Telegram: {link.botUnverified}. Если ссылка не откроется, возьмите новую чуть позже.
            </p>
          )}
          <a
            href={link.link}
            target="_blank"
            rel="noopener noreferrer"
            className="block break-all text-xs font-mono text-[var(--ocean)] underline"
          >
            {link.link}
          </a>
          <button type="button" onClick={() => copy(link.link)} className="ds-btn ds-btn-secondary w-full text-sm">
            {copied ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
          {copyError && <p className="text-xs text-[var(--danger)]" role="alert">{copyError}</p>}
        </div>
      )}

      <details className="group mt-auto">
        <summary className="cursor-pointer text-xs text-[var(--ocean)] min-h-11 inline-flex items-center gap-1 list-none [&::-webkit-details-marker]:hidden">
          Что умеет бот
          <ChevronDown className="w-3.5 h-3.5 transition-transform duration-200 group-open:rotate-180" aria-hidden />
        </summary>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed pb-1">{spec.ability}</p>
      </details>
    </div>
  );
}

export default function AdminMessengers() {
  return (
    <section aria-labelledby="admin-messengers-title" className="space-y-3">
      <h2 id="admin-messengers-title" className="text-base font-semibold text-[var(--text-primary)]">
        Мессенджеры администратора
      </h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 list-none m-0 p-0 items-start">
        {MESSENGERS.map((spec) => (
          <li key={spec.id} className="min-w-0">
            <MessengerTile spec={spec} />
          </li>
        ))}
      </ul>
    </section>
  );
}
