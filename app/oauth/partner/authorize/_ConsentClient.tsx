'use client';

/**
 * Экран согласия OAuth MCP партнёра — клиентская часть. Решения тут нет:
 * что показать, решил сервер (page.tsx); здесь — кнопки.
 *
 * «Разрешить» — POST на роут решения, ответом приходит адрес с кодом, и
 * браузер уходит туда сам (window.location): переход после формы с
 * редиректом на чужой домен браузер мог бы остановить политикой
 * form-action, переход скриптом — нет. «Отказать» — обычная ссылка на адрес
 * возврата с error=access_denied: отказу не нужны ни вход, ни база.
 */
import { useState, type ReactNode } from 'react';
import { Bot, ShieldCheck } from 'lucide-react';
import { PARTNER_OAUTH_DECISION_API } from '@/lib/crm/partner-oauth-public';
import { useAuth } from '@/contexts/AuthContext';

interface SwitchTarget {
  role: string;
  label: string;
  name: string | null;
}

export type ConsentProps =
  | { mode: 'fatal'; message: string }
  | (CommonProps & { mode: 'login'; loginHref: string })
  | (CommonProps & { mode: 'none'; message: string; loginHref: string; switchTo: SwitchTarget[] })
  | (CommonProps & { mode: 'unavailable' })
  | (CommonProps & {
      mode: 'consent';
      partnerName: string | null;
      wantsWrite: boolean;
      decision: Record<string, string>;
    });

export interface CommonProps {
  clientName: string;
  destination: string;
  denyHref: string;
  /** Код уйдёт программе на этом компьютере (Claude Code), а не на claude.ai. */
  loopback: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="ds-page min-h-screen px-4 py-10">
      <div className="ds-card mx-auto max-w-md space-y-5 p-6">
        <div className="flex items-center gap-2.5">
          <Bot className="h-5 w-5 text-[var(--ocean)]" aria-hidden />
          <h1 className="font-playfair text-xl font-bold text-[var(--text-primary)]">Подключение к CRM Ведара</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

function Deny({ href, label = 'Отказать' }: { href: string; label?: string }) {
  return <a href={href} className="ds-btn ds-btn-secondary">{label}</a>;
}

export function ConsentClient(props: ConsentProps) {
  const { signOut } = useAuth();
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Войти как партнёр — тот же /api/auth/switch-role, что у переключателя в
   * шапке: владение ролью проверяет сервер. Затем страница перерисовывается
   * с новой ролью и показывает согласие. Прямой fetch, а не switchRole из
   * контекста: в окне входа из Claude профиля в localStorage может не быть,
   * а кука есть — контекст отказал бы «Не авторизован» при живом входе.
   */
  async function enterAs(role: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/switch-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (res.ok && isRecord(json) && json.success === true) {
        window.location.reload();
        return;
      }
      setError(isRecord(json) && typeof json.error === 'string' ? json.error : 'Не удалось переключить роль');
    } catch {
      setError('Нет связи с сервером — роль не переключена');
    }
    setBusy(false);
  }

  /** Войти другим аккаунтом: выход этого входа и форма входа с возвратом сюда. */
  async function otherAccount(loginHref: string) {
    setBusy(true);
    try {
      await signOut();
    } catch {
      // Выход не удался — форма входа всё равно заменит куку новым входом.
    }
    window.location.assign(loginHref);
  }

  if (props.mode === 'fatal') {
    return (
      <Shell>
        <p role="alert" className="text-sm text-[var(--text-secondary)]">{props.message}</p>
      </Shell>
    );
  }

  if (props.mode === 'login') {
    return (
      <Shell>
        <p className="text-sm text-[var(--text-secondary)]">
          Чтобы подключить {props.clientName} к своей CRM, войдите в кабинет партнёра Ведара. После входа вы вернётесь сюда.
        </p>
        <div className="flex flex-wrap gap-2">
          <a href={props.loginHref} className="ds-btn ds-btn-primary">Войти</a>
          <Deny href={props.denyHref} />
        </div>
      </Shell>
    );
  }

  if (props.mode === 'none') {
    return (
      <Shell>
        <p className="text-sm text-[var(--text-secondary)]">{props.message}</p>
        <p className="text-sm text-[var(--text-secondary)]">
          Чтобы подключить {props.clientName} к CRM, {props.switchTo.length > 0 ? 'войдите как партнёр или другим аккаунтом' : 'войдите аккаунтом партнёра'}.
        </p>
        <div className="flex flex-col gap-2">
          {props.switchTo.map((t) => (
            <button key={t.role} type="button" disabled={busy} onClick={() => void enterAs(t.role)} className="ds-btn ds-btn-primary">
              Войти как {t.label}{t.name ? ` — ${t.name}` : ''}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => void otherAccount(props.loginHref)}
            className={props.switchTo.length > 0 ? 'ds-btn ds-btn-secondary' : 'ds-btn ds-btn-primary'}
          >
            Войти другим аккаунтом
          </button>
          <Deny href={props.denyHref} label="Вернуться в Claude" />
        </div>
        {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      </Shell>
    );
  }

  if (props.mode === 'unavailable') {
    return (
      <Shell>
        <p role="alert" className="text-sm text-[var(--text-secondary)]">
          Не удалось проверить кабинет партнёра — попробуйте ещё раз через минуту.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => window.location.reload()} className="ds-btn ds-btn-primary">Повторить</button>
          <Deny href={props.denyHref} />
        </div>
      </Shell>
    );
  }

  const { decision } = props;

  async function allow() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(PARTNER_OAUTH_DECISION_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...decision, can_write: canWrite }),
      });
      const json: unknown = await res.json().catch(() => null);
      const redirect = isRecord(json) && isRecord(json.data) && typeof json.data.redirect === 'string' ? json.data.redirect : null;
      if (res.ok && redirect) {
        window.location.assign(redirect);
        return;
      }
      setError(isRecord(json) && typeof json.error === 'string' ? json.error : 'Не удалось подключить — попробуйте ещё раз');
    } catch {
      setError('Нет связи с сервером — подключение не выполнено');
    }
    setBusy(false);
  }

  return (
    <Shell>
      <p className="text-sm text-[var(--text-primary)]">
        <strong>{props.clientName}</strong> просит доступ к CRM {props.partnerName ? <>кабинета «{props.partnerName}»</> : 'вашего кабинета'}.
      </p>

      <div className="space-y-1.5 text-sm text-[var(--text-secondary)]">
        <p>Агент увидит:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>клиентов — подписью вроде «Анна П.», без телефонов и почт;</li>
          <li>их брони, заметки и историю касаний;</li>
          <li>входящие и задачи.</li>
        </ul>
      </div>

      {props.wantsWrite && (
        <label className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
          <input type="checkbox" className="mt-1" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} />
          <span>Разрешить запись: заметки, звонки, задачи и их выполнение. Без отметки — только чтение.</span>
        </label>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden />
        <div className="space-y-1">
          <p>Код подключения уйдёт: <strong className="text-[var(--text-primary)]">{props.destination}</strong>.</p>
          {props.loopback && (
            <p className="text-[var(--warning)]">Если вы не запускали подключение Claude Code на этом компьютере сами — откажите.</p>
          )}
          <p>Отключить агента можно в кабинете: «Задачи» → «Свой ИИ-агент».</p>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void allow()} className="ds-btn ds-btn-primary">
          {busy ? 'Подключаем…' : 'Разрешить'}
        </button>
        <Deny href={props.denyHref} />
      </div>
    </Shell>
  );
}
