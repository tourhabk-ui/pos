'use client';

/**
 * «MAX администратора» на обзоре админки (слово владельца 23.10: «Я админ и
 * чат должен знать что админ подключен со всеми правами»; способ «1а»).
 * Кнопка выдаёт одноразовую ссылку на 10 минут; администратор открывает её в
 * своём MAX и жмёт «Старт» — бот узнаёт его на каждом сообщении, пока у
 * аккаунта есть роль администратора. Правила — lib/max/admin-link.
 *
 * Состояние, которое не прочиталось, так и названо (§4.0): «не загрузилось»
 * вместо «не подключён».
 */

import React, { useEffect, useState } from 'react';
import { Check, Copy, Loader2, MessageCircle, AlertTriangle } from 'lucide-react';

type Status =
  | { kind: 'loading' }
  | { kind: 'bound'; boundAt: string | null }
  | { kind: 'unbound' }
  | { kind: 'failed'; error: string };

type Link =
  | { kind: 'none' }
  | { kind: 'issuing' }
  | { kind: 'ready'; link: string; expiresAt: string }
  | { kind: 'error'; error: string };

const kamchatkaTime = (iso: string, withDate: boolean): string =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Asia/Kamchatka',
    ...(withDate ? { day: 'numeric', month: 'long' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });

async function readStatus(): Promise<Status> {
  try {
    const res = await fetch('/api/admin/max-link', { cache: 'no-store' });
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

async function readJson(res: Response): Promise<{ success?: boolean; error?: unknown; data?: Record<string, unknown> } | null> {
  return res.json().catch(() => null) as Promise<{ success?: boolean; error?: unknown; data?: Record<string, unknown> } | null>;
}

export default function AdminMaxLink() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [link, setLink] = useState<Link>({ kind: 'none' });
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    readStatus().then((next) => { if (alive) setStatus(next); });
    return () => { alive = false; };
  }, []);

  async function recheck() {
    setStatus({ kind: 'loading' });
    setStatus(await readStatus());
  }

  async function issue() {
    setLink({ kind: 'issuing' });
    setCopied(false);
    setCopyError(null);
    try {
      const res = await fetch('/api/admin/max-link', { method: 'POST' });
      const body = await readJson(res);
      const data = body?.data;
      if (!res.ok || !body?.success || typeof data?.link !== 'string' || typeof data.expires_at !== 'string') {
        setLink({ kind: 'error', error: typeof body?.error === 'string' ? body.error : `Сервер ответил ${res.status}` });
        return;
      }
      setLink({ kind: 'ready', link: data.link, expiresAt: data.expires_at });
    } catch {
      setLink({ kind: 'error', error: 'Нет связи с сервером' });
    }
  }

  async function unbind() {
    setUnbinding(true);
    try {
      const res = await fetch('/api/admin/max-link', { method: 'DELETE' });
      const body = await readJson(res);
      if (!res.ok || !body?.success) {
        setStatus({ kind: 'failed', error: typeof body?.error === 'string' ? body.error : `Сервер ответил ${res.status}` });
        return;
      }
      setConfirmUnbind(false);
      setLink({ kind: 'none' });
      setStatus({ kind: 'unbound' });
    } catch {
      setStatus({ kind: 'failed', error: 'Нет связи с сервером' });
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
    <section
      aria-labelledby="admin-max-title"
      className="p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] space-y-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <MessageCircle className="w-4 h-4 text-[var(--ocean)] shrink-0" aria-hidden />
        <h2 id="admin-max-title" className="font-semibold text-[var(--text-primary)]">MAX администратора</h2>
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

      <p className="text-xs text-[var(--text-secondary)]">
        В личном чате с ботом Ведара в MAX бот узнаёт вас как администратора: брони, заявки, открытые даты,
        сводка суток и состояние сторожа. Права проверяются на каждом сообщении — снимут роль на сайте, снимутся и там.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={issue}
          disabled={link.kind === 'issuing'}
          className="ds-btn ds-btn-secondary text-xs px-2 py-1"
        >
          {link.kind === 'issuing'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="Выдаю ссылку" />
            : status.kind === 'bound' ? 'Подключить заново' : 'Подключить MAX администратора'}
        </button>
        {status.kind === 'bound' && !confirmUnbind && (
          <button type="button" onClick={() => setConfirmUnbind(true)} className="ds-btn ds-btn-secondary text-xs px-2 py-1">
            Отключить
          </button>
        )}
        {status.kind === 'bound' && confirmUnbind && (
          <span className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
            Отключить MAX администратора?
            <button type="button" onClick={unbind} disabled={unbinding} className="ds-btn ds-btn-danger text-xs px-2 py-1">
              {unbinding ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="Отключаю" /> : 'Да, отключить'}
            </button>
            <button type="button" onClick={() => setConfirmUnbind(false)} className="ds-btn ds-btn-secondary text-xs px-2 py-1">
              Нет
            </button>
          </span>
        )}
      </div>

      {link.kind === 'error' && <p className="text-xs text-[var(--danger)]" role="alert">{link.error}</p>}
      {link.kind === 'ready' && (
        <div className="space-y-1.5">
          <p className="text-xs text-[var(--text-secondary)]">
            Откройте ссылку там, где ваш MAX, и нажмите «Старт». Ссылка одна, действует до{' '}
            {kamchatkaTime(link.expiresAt, false)} по Камчатке. Никому её не пересылайте: кто нажмёт «Старт»,
            тот и станет администратором в чате.
          </p>
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
    </section>
  );
}
