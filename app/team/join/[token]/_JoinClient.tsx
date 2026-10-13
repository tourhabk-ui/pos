'use client';

/**
 * Принять приглашение в команду оператора (CRM фаза 2г).
 *
 * Ссылку владелец кабинета пересылает «любым способом» (решение 11.10), и
 * открыть её может человек без входа. Тогда страница ведёт на вход и
 * регистрацию с возвратом сюда же (safeTeamJoinReturn на странице входа).
 * Принятое приглашение добавляет роль «оператор» в роли аккаунта; страница
 * переключает роль тем же /api/auth/switch-role, что и переключатель в шапке,
 * и открывает кабинет.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Check, Loader2, LogIn, RefreshCw, UserPlus, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { invitePath, isInviteTokenShape } from '@/lib/operators/team-join-path';

interface Preview {
  operator_name: string;
  label: string | null;
  expires_at: string | null;
  perms: { can_edit_prices: boolean; can_cancel_bookings: boolean };
}

type State =
  | { kind: 'checking' }
  | { kind: 'login' }
  | { kind: 'preview'; preview: Preview }
  | { kind: 'gone'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'joined'; operator: string; switchError: string | null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function errorOf(json: unknown, fallback: string): string {
  return isRecord(json) && typeof json.error === 'string' ? json.error : fallback;
}

function isPreview(v: unknown): v is Preview {
  if (!isRecord(v) || typeof v.operator_name !== 'string' || !isRecord(v.perms)) return false;
  return typeof v.perms.can_edit_prices === 'boolean' && typeof v.perms.can_cancel_bookings === 'boolean';
}

function untilDay(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Kamchatka' });
}

/** Что за приглашение — следующее состояние страницы. Без setState: его ставит вызывающий. */
async function requestInvite(token: string): Promise<State> {
  try {
    const res = await fetch(`/api/team/join/${token}`);
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 401) return { kind: 'login' };
    if (res.ok && isRecord(json) && json.success === true && isPreview(json.data)) {
      return { kind: 'preview', preview: json.data };
    }
    if (res.status === 404 || res.status === 409 || res.status === 410) {
      return { kind: 'gone', text: errorOf(json, 'Ссылка недействительна — попросите у оператора новую') };
    }
    return { kind: 'error', text: errorOf(json, `Приглашение не проверено (HTTP ${res.status})`) };
  } catch {
    return { kind: 'error', text: 'Нет связи с сервером — приглашение не проверено' };
  }
}

export default function JoinClient({ token }: { token: string }) {
  const { user, switchRole } = useAuth();
  const shapeOk = isInviteTokenShape(token);
  const [state, setState] = useState<State>(() => shapeOk
    ? { kind: 'checking' }
    : { kind: 'gone', text: 'Ссылка повреждена — скопируйте её целиком или попросите у оператора новую' });
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const back = encodeURIComponent(invitePath(token));

  const check = useCallback(async () => {
    if (!shapeOk) return;
    setState({ kind: 'checking' });
    setState(await requestInvite(token));
  }, [shapeOk, token]);

  // Состояние ставится в колбэке ответа, а не в теле эффекта: страница при
  // открытии не перерисовывается лишний раз (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!shapeOk) return;
    let alive = true;
    void requestInvite(token).then(next => { if (alive) setState(next); });
    return () => { alive = false; };
  }, [shapeOk, token]);

  /** Роль «оператор» уже в ролях аккаунта — переключаемся и открываем кабинет. */
  async function enterCabinet(operator: string) {
    try {
      let redirect = '/hub/operator';
      if (user) {
        // Через контекст: Bearer-сессия получает новый токен и в localStorage.
        redirect = await switchRole('operator');
      } else {
        const res = await fetch('/api/auth/switch-role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'operator' }),
        });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok || !isRecord(json) || json.success !== true) {
          throw new Error(errorOf(json, `роль не переключена (HTTP ${res.status})`));
        }
        if (isRecord(json.data) && typeof json.data.redirect === 'string') redirect = json.data.redirect;
        // Сразу после регистрации контекст входа ещё пуст, а профиль с токеном
        // роли «турист» уже лежит в localStorage: гарды API читают заголовок
        // Authorization раньше куки, и старый токен закрыл бы кабинет.
        // Обновляем его так же, как switchRole контекста.
        if (isRecord(json.data) && typeof json.data.token === 'string') {
          try {
            const raw = localStorage.getItem('user');
            if (raw) {
              const stored: unknown = JSON.parse(raw);
              if (isRecord(stored)) {
                localStorage.setItem('user', JSON.stringify({ ...stored, role: 'operator', token: json.data.token }));
              }
            }
          } catch {
            // Хранилище недоступно — сессия в куке уже обновлена сервером.
          }
        }
      }
      window.location.assign(redirect);
    } catch (err) {
      setState({ kind: 'joined', operator, switchError: err instanceof Error ? err.message : 'роль не переключена' });
    }
  }

  async function accept() {
    setAccepting(true);
    setAcceptError(null);
    try {
      const res = await fetch(`/api/team/join/${token}`, { method: 'POST' });
      const json: unknown = await res.json().catch(() => null);
      if (res.ok && isRecord(json) && json.success === true && isRecord(json.data) && typeof json.data.operator_name === 'string') {
        const operator = json.data.operator_name;
        setState({ kind: 'joined', operator, switchError: null });
        await enterCabinet(operator);
        return;
      }
      if (res.status === 401) {
        setState({ kind: 'login' });
        return;
      }
      if (res.status === 404 || res.status === 409 || res.status === 410) {
        setState({ kind: 'gone', text: errorOf(json, 'Ссылка недействительна — попросите у оператора новую') });
        return;
      }
      setAcceptError(errorOf(json, `Приглашение не принято (HTTP ${res.status})`));
    } catch {
      setAcceptError('Нет связи с сервером — приглашение не принято');
    } finally {
      setAccepting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--bg-primary)] py-12 px-4">
      <div className="max-w-md mx-auto space-y-4">
        <h1 className="ds-h1 flex items-center gap-2">
          <Users className="w-6 h-6 text-[var(--accent)]" /> Команда оператора
        </h1>

        {state.kind === 'checking' && (
          <p className="ds-card p-5 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> Проверяем приглашение…
          </p>
        )}

        {state.kind === 'login' && (
          <section className="ds-card p-5 space-y-4">
            <p className="text-sm text-[var(--text-primary)]">
              Вас пригласили менеджером в кабинет оператора. Чтобы принять приглашение, войдите своим аккаунтом Ведара.
            </p>
            <p className="text-sm text-[var(--text-secondary)]">
              Аккаунта нет — зарегистрируйтесь как путешественник: кабинет оператора откроется после того, как вы примете
              приглашение. Свой кабинет оператора заводить не нужно — с ним приглашение не принять.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href={`/auth/login?next=${back}`} className="ds-btn ds-btn-primary inline-flex items-center gap-1.5">
                <LogIn className="w-4 h-4" /> Войти
              </Link>
              <Link href={`/auth/login?mode=register&next=${back}`} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5">
                <UserPlus className="w-4 h-4" /> Зарегистрироваться
              </Link>
            </div>
          </section>
        )}

        {state.kind === 'preview' && (
          <section className="ds-card p-5 space-y-4">
            <p className="text-sm text-[var(--text-primary)]">
              <span className="font-semibold">{state.preview.operator_name}</span> приглашает вас менеджером в свой кабинет
              {state.preview.label ? <> (подпись владельца: «{state.preview.label}»)</> : null}.
            </p>
            <div className="space-y-1 text-sm text-[var(--text-secondary)]">
              <p>Вы будете вести заявки, брони, клиентов и туры этого оператора. Деньги и настройки кабинета — у владельца.</p>
              <p>
                {state.preview.perms.can_edit_prices ? 'Цены туров менять можно.' : 'Цены туров меняет владелец.'}{' '}
                {state.preview.perms.can_cancel_bookings ? 'Отменять брони можно.' : 'Отменяет брони владелец.'}
              </p>
              <p>Владелец увидит ваше имя и почту аккаунта и может закрыть доступ в любой момент.</p>
              {untilDay(state.preview.expires_at) && (
                <p className="text-xs text-[var(--text-muted)]">Ссылка действует до {untilDay(state.preview.expires_at)}.</p>
              )}
            </div>
            {acceptError && (
              <p role="alert" className="text-sm text-[var(--danger)]">{acceptError}</p>
            )}
            <button type="button" onClick={() => void accept()} disabled={accepting} className="ds-btn ds-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50">
              {accepting ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Check className="w-4 h-4" />} Принять приглашение
            </button>
          </section>
        )}

        {state.kind === 'joined' && (
          <section role="status" className="ds-card p-5 space-y-3">
            <p className="text-sm text-[var(--text-primary)] flex items-center gap-2">
              <Check className="w-4 h-4 text-[var(--success)]" /> Вы в команде «{state.operator}».
            </p>
            {state.switchError ? (
              <>
                <p className="text-sm text-[var(--text-secondary)]">
                  Кабинет не открылся сам: {state.switchError}. Переключите роль на «Туроператор» в шапке сайта — роль уже
                  добавлена в ваш аккаунт.
                </p>
                <Link href="/hub/operator" className="ds-btn ds-btn-secondary">Открыть кабинет оператора</Link>
              </>
            ) : (
              <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> Открываем кабинет…
              </p>
            )}
          </section>
        )}

        {state.kind === 'gone' && (
          <section role="alert" className="ds-card p-5 space-y-3">
            <p className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" /> {state.text}
            </p>
            <Link href="/" className="ds-btn ds-btn-secondary">На главную</Link>
          </section>
        )}

        {state.kind === 'error' && (
          <section role="alert" className="ds-card p-5 space-y-3">
            <p className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" /> {state.text}
            </p>
            <button type="button" onClick={() => void check()} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5">
              <RefreshCw className="w-4 h-4" /> Повторить
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
