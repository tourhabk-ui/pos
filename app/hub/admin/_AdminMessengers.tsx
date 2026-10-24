'use client';

/**
 * «Мессенджеры администратора» на обзоре админки.
 *
 * MAX — слово владельца 23.10 («1а»). Telegram — 24.10: «нет привязки админа
 * к Telegram», тот же способ: одноразовая ссылка на 10 минут и «Старт».
 * Состояние, которое не прочиталось, так и названо (§4.0): «не загрузилось»
 * вместо «не подключён». Имя бота Telegram, которое не подтвердил getMe,
 * так и сказано — ссылка при этом не прячется.
 */

import React, { useEffect, useState } from 'react';
import { Check, Copy, Loader2, MessageCircle, Send, AlertTriangle, type LucideIcon } from 'lucide-react';

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
  icon: LucideIcon;
  connectLabel: string;
  unbindQuestion: string;
  blurb: string;
  openHint: string;
}

const MESSENGERS: MessengerSpec[] = [
  {
    id: 'max',
    title: 'MAX',
    endpoint: '/api/admin/max-link',
    icon: MessageCircle,
    connectLabel: 'Подключить MAX администратора',
    unbindQuestion: 'Отключить MAX администратора?',
    blurb: 'В личном чате с ботом Ведара в MAX бот узнаёт вас как администратора: брони, заявки, открытые даты, сводка суток и состояние сторожа. Права проверяются на каждом сообщении — снимут роль на сайте, снимутся и там.',
    openHint: 'Откройте ссылку там, где ваш MAX, и нажмите «Старт».',
  },
  {
    id: 'telegram',
    title: 'Telegram',
    endpoint: '/api/admin/telegram-link',
    icon: Send,
    connectLabel: 'Подключить Telegram администратора',
    unbindQuestion: 'Отключить Telegram администратора?',
    blurb: 'В личном чате с ботом Ведара в Telegram — те же кнопки. Контакты туристов здесь не показываются: они остаются в MAX. Права проверяются на каждом сообщении.',
    openHint: 'Откройте ссылку в Telegram и нажмите «Старт».',
  },
];

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

async function readJson(res: Response): Promise<{ success?: boolean; error?: unknown; data?: Record<string, unknown> } | null> {
  return res.json().catch(() => null) as Promise<{ success?: boolean; error?: unknown; data?: Record<string, unknown> } | null>;
}

function MessengerRow({ spec }: { spec: MessengerSpec }) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [link, setLink] = useState<Link>({ kind: 'none' });
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [unbindError, setUnbindError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const titleId = `admin-messenger-${spec.id}`;
  const Icon = spec.icon;

  useEffect(() => {
    let alive = true;
    readStatus(spec.endpoint).then((next) => { if (alive) setStatus(next); });
    return () => { alive = false; };
  }, [spec.endpoint]);

  async function recheck() {
    setStatus({ kind: 'loading' });
    setStatus(await readStatus(spec.endpoint));
  }

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

  return (
    <div role="group" aria-labelledby={titleId} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="w-4 h-4 text-[var(--ocean)] shrink-0" aria-hidden />
        <h3 id={titleId} className="font-semibold text-[var(--text-primary)]">{spec.title}</h3>
        {status.kind === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" aria-label="Загрузка" />}
        {status.kind === 'bound' && (
          <span className="text-xs px-2 py-0.5 rounded bg-[var(--success)]/15 text-[var(--success)]">
            {`подключён${status.boundAt ? ` ${kamchatkaTime(status.boundAt, true)}` : ''}`}
          </span>
        )}
        {status.kind === 'unbound' && (
          <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-muted)]">не подключён</span>
        )}
        {status.kind === 'failed' && (
          <span className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
            <AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--warning)' }} aria-hidden />
            не загрузилось: {status.error}
          </span>
        )}
      </div>

      <p className="text-xs text-[var(--text-secondary)]">{spec.blurb}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={issue}
          disabled={link.kind === 'issuing'}
          className="ds-btn ds-btn-secondary text-xs px-2 py-1"
        >
          {link.kind === 'issuing'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="Выдаю ссылку" />
            : status.kind === 'bound' ? 'Подключить заново' : spec.connectLabel}
        </button>
        {status.kind === 'bound' && !confirmUnbind && (
          <button type="button" onClick={() => setConfirmUnbind(true)} className="ds-btn ds-btn-secondary text-xs px-2 py-1">
            Отключить
          </button>
        )}
        {status.kind === 'bound' && confirmUnbind && (
          <span className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
            {spec.unbindQuestion}
            <button type="button" onClick={unbind} disabled={unbinding} className="ds-btn ds-btn-danger text-xs px-2 py-1">
              {unbinding ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="Отключаю" /> : 'Да, отключить'}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmUnbind(false); setUnbindError(null); }}
              className="ds-btn ds-btn-secondary text-xs px-2 py-1"
            >
              Нет
            </button>
          </span>
        )}
      </div>
      {status.kind === 'bound' && unbindError && (
        <p className="text-xs text-[var(--danger)]" role="alert">
          Не отключено: {unbindError}. {spec.title} администратора всё ещё подключён — нажмите «Да, отключить» ещё раз.
        </p>
      )}

      {link.kind === 'error' && <p className="text-xs text-[var(--danger)]" role="alert">{link.error}</p>}
      {link.kind === 'ready' && (
        <div className="space-y-1.5">
          <p className="text-xs text-[var(--text-secondary)]">
            {spec.openHint} Ссылка одна, действует до {kamchatkaTime(link.expiresAt, false)} по Камчатке.
            Никому её не пересылайте: кто нажмёт «Старт», тот и станет администратором в чате.
          </p>
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
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => copy(link.link)} className="ds-btn ds-btn-secondary text-xs px-2 py-1 inline-flex items-center gap-1">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Скопировано' : 'Скопировать ссылку'}
            </button>
            <button type="button" onClick={() => void recheck()} className="ds-btn ds-btn-secondary text-xs px-2 py-1">
              Проверить подключение
            </button>
          </div>
          {copyError && <p className="text-xs text-[var(--danger)]" role="alert">{copyError}</p>}
        </div>
      )}
    </div>
  );
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

export default function AdminMessengers() {
  return (
    <section
      aria-labelledby="admin-messengers-title"
      className="p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] space-y-4 text-sm"
    >
      <h2 id="admin-messengers-title" className="font-semibold text-[var(--text-primary)]">Мессенджеры администратора</h2>
      <p className="text-xs text-[var(--text-secondary)]">
        Один аккаунт можно подключить к MAX и к Telegram. Ссылка живёт 10 минут и привязывает человека, который нажмёт «Старт».
      </p>
      {MESSENGERS.map((spec) => <MessengerRow key={spec.id} spec={spec} />)}
    </section>
  );
}
