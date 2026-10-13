'use client';

/**
 * «Команда» кабинета оператора (CRM фаза 2г, решение владельца 11.10).
 *
 * Менеджер попадает в команду по ссылке, которую владелец пересылает любым
 * способом. Ссылка показывается один раз — в базе только её отпечаток, —
 * действует 7 дней и принимается один раз. Кто принял, виден здесь именем и
 * почтой аккаунта: чужого владелец снимает, и доступ закрывается сразу.
 *
 * Права менеджера по умолчанию — всё, кроме денег и настроек. Цены и отмену
 * броней владелец открывает отдельно. Что именно увидит менеджер, экран
 * читает из того же списка, что строит меню (components/operator/operator-menu.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, Check, Copy, Link2, Loader2, RefreshCw, Share2, UserMinus, UserPlus, X,
} from 'lucide-react';
import { OPERATOR_MENU, type MenuAccess } from '@/components/operator/operator-menu';
import { shareLink, shareOutcomeMessage } from '@/lib/share';

type Perm = 'can_edit_prices' | 'can_cancel_bookings';

interface Member {
  id: string;
  status: 'invited' | 'active' | 'revoked';
  label: string | null;
  user_name: string | null;
  user_email: string | null;
  can_edit_prices: boolean;
  can_cancel_bookings: boolean;
  created_at: string;
  invite_expires_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  expired: boolean;
}

const PERMS: { key: Perm; title: string; hint: string }[] = [
  {
    key: 'can_edit_prices',
    title: 'Цены',
    hint: 'создавать туры, менять цены туров и дат, назначать скидки, ставить свою цену в ручной брони',
  },
  { key: 'can_cancel_bookings', title: 'Отмена броней', hint: 'отменять брони туристов' },
];

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; text: string; retry: boolean }
  | { kind: 'ready'; members: Member[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function errorOf(json: unknown, fallback: string): string {
  return isRecord(json) && typeof json.error === 'string' ? json.error : fallback;
}

/** Время из базы приходит текстом PostgreSQL («2026-10-13 04:20:00+00») или ISO. */
function toDate(s: string | null): Date | null {
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function day(s: string | null): string {
  const d = toDate(s);
  return d ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Kamchatka' }) : 'дата не записана';
}

function labelsBy(access: MenuAccess): string[] {
  return OPERATOR_MENU.filter(i => i.access === access).map(i => i.label);
}

/** Команда с сервера — следующее состояние экрана. Без setState: его ставит вызывающий. */
async function requestTeam(): Promise<Load> {
  try {
    const res = await fetch('/api/hub/operator/team');
    const json: unknown = await res.json().catch(() => null);
    if (res.ok && isRecord(json) && json.success === true && isRecord(json.data) && Array.isArray(json.data.members)) {
      return { kind: 'ready', members: json.data.members as Member[] };
    }
    // 403 — менеджер или не владелец: повтор не поможет. 503 и прочее — поможет.
    return { kind: 'error', text: errorOf(json, `Команда не загружена (HTTP ${res.status})`), retry: res.status !== 403 };
  } catch {
    return { kind: 'error', text: 'Нет связи с сервером — команда не загружена', retry: true };
  }
}

export default function TeamClient() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [label, setLabel] = useState('');
  const [perms, setPerms] = useState<Record<Perm, boolean>>({ can_edit_prices: false, can_cancel_bookings: false });
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ url: string; label: string | null } | null>(null);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  /** «Повторить» после сбоя — с загрузкой. */
  const reload = useCallback(async () => {
    setLoad({ kind: 'loading' });
    setLoad(await requestTeam());
  }, []);

  /** После действия — без загрузки: список не мигает на каждой галочке. */
  const refresh = useCallback(async () => {
    setLoad(await requestTeam());
  }, []);

  // Состояние ставится в колбэке ответа, а не в теле эффекта: экран при
  // открытии не перерисовывается лишний раз (react-hooks/set-state-in-effect).
  useEffect(() => {
    let alive = true;
    void requestTeam().then(next => { if (alive) setLoad(next); });
    return () => { alive = false; };
  }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setNotice(null);
    setCopied(null);
    setShareNote(null);
    try {
      const res = await fetch('/api/hub/operator/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || undefined, ...perms }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (res.ok && isRecord(json) && json.success === true && isRecord(json.data) && typeof json.data.path === 'string') {
        setFresh({ url: `${window.location.origin}${json.data.path}`, label: label.trim() || null });
        setLabel('');
        setPerms({ can_edit_prices: false, can_cancel_bookings: false });
        await refresh();
        return;
      }
      setNotice({ ok: false, text: errorOf(json, `Ссылка не создана (HTTP ${res.status})`) });
    } catch {
      setNotice({ ok: false, text: 'Нет связи с сервером — ссылка не создана' });
    } finally {
      setCreating(false);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }

  async function share(url: string) {
    // Исход разбирается: «скопировано» и «не вышло» обязаны быть видны (lib/share.ts).
    // Ссылка здесь не в адресной строке, а на экране — об этом и говорим.
    const outcome = await shareLink({ title: 'Приглашение в команду оператора', url });
    setShareNote(outcome === 'unavailable'
      ? 'Не удалось поделиться — выделите ссылку выше и скопируйте вручную'
      : shareOutcomeMessage(outcome));
  }

  async function setPerm(m: Member, perm: Perm, value: boolean) {
    setBusyId(m.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/hub/operator/team/${m.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [perm]: value }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || !isRecord(json) || json.success !== true) {
        setNotice({ ok: false, text: errorOf(json, `Права не изменены (HTTP ${res.status})`) });
      }
      await refresh();
    } catch {
      setNotice({ ok: false, text: 'Нет связи с сервером — права не изменены' });
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(m: Member) {
    setBusyId(m.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/hub/operator/team/${m.id}`, { method: 'DELETE' });
      const json: unknown = await res.json().catch(() => null);
      if (res.ok && isRecord(json) && json.success === true) {
        setNotice({
          ok: true,
          text: m.status === 'active'
            ? `Доступ к кабинету закрыт: ${m.user_name || m.label || 'менеджер'} больше не в команде`
            : 'Ссылка отозвана — по ней больше не войти',
        });
      } else {
        setNotice({ ok: false, text: errorOf(json, `Не получилось (HTTP ${res.status})`) });
      }
      setConfirmId(null);
      await refresh();
    } catch {
      setNotice({ ok: false, text: 'Нет связи с сервером — ничего не изменено' });
    } finally {
      setBusyId(null);
    }
  }

  const members = load.kind === 'ready' ? load.members : [];
  const active = members.filter(m => m.status === 'active');
  const invited = members.filter(m => m.status === 'invited');
  const revoked = members.filter(m => m.status === 'revoked');

  function permBoxes(m: Member) {
    return (
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {PERMS.map(p => (
          <label key={p.key} className="flex items-center gap-2 cursor-pointer min-h-[44px]">
            <input
              type="checkbox"
              checked={m[p.key]}
              disabled={busyId === m.id}
              onChange={e => void setPerm(m, p.key, e.target.checked)}
              className="w-4 h-4 accent-[var(--accent)]"
            />
            <span className="text-sm text-[var(--text-primary)]">{p.title}</span>
          </label>
        ))}
      </div>
    );
  }

  function removeButton(m: Member, text: string) {
    if (confirmId === m.id) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-[var(--text-primary)]">
            {m.status === 'active' ? 'Снять? Доступ закроется сразу.' : 'Отозвать ссылку?'}
          </span>
          <button type="button" disabled={busyId === m.id} onClick={() => void revoke(m)} className="ds-btn ds-btn-danger inline-flex items-center gap-1.5 disabled:opacity-50">
            {busyId === m.id ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Check className="w-4 h-4" />} Да
          </button>
          <button type="button" onClick={() => setConfirmId(null)} className="ds-btn ds-btn-secondary">Нет</button>
        </div>
      );
    }
    return (
      <button type="button" onClick={() => setConfirmId(m.id)} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5">
        {m.status === 'active' ? <UserMinus className="w-4 h-4" /> : <X className="w-4 h-4" />} {text}
      </button>
    );
  }

  return (
    <div className="ds-page space-y-6">
      <div>
        <h1 className="ds-h1">Команда</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Менеджеры ведут заявки, брони и клиентов в вашем кабинете. Деньги и настройки видите только вы.
        </p>
      </div>

      {notice && (
        <p role="status" className={`text-sm ${notice.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{notice.text}</p>
      )}

      {load.kind === 'error' ? (
        <div role="alert" className="ds-card p-4 flex items-start gap-3 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" />
          <p className="flex-1 text-[var(--text-primary)]">{load.text}</p>
          {load.retry && (
            <button type="button" onClick={() => void reload()} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 shrink-0">
              <RefreshCw className="w-4 h-4" /> Повторить
            </button>
          )}
        </div>
      ) : (
        <>
          <section className="ds-card p-5 space-y-4" aria-label="Пригласить менеджера">
            <h2 className="ds-h2 text-lg">Пригласить менеджера</h2>
            <form onSubmit={invite} className="space-y-4">
              <label className="flex flex-col gap-1 max-w-md">
                <span className="ds-label">Кого приглашаете — подпись для себя</span>
                <input
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  maxLength={100}
                  placeholder="Например: Анна, бронирования"
                  className="ds-input text-sm"
                />
              </label>
              <fieldset className="space-y-2">
                <legend className="ds-label">Кроме заявок, броней и клиентов разрешить</legend>
                {PERMS.map(p => (
                  <label key={p.key} className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={perms[p.key]}
                      onChange={e => setPerms(prev => ({ ...prev, [p.key]: e.target.checked }))}
                      className="w-4 h-4 mt-0.5 accent-[var(--accent)]"
                    />
                    <span className="text-sm text-[var(--text-primary)]">
                      {p.title} <span className="text-[var(--text-secondary)]">— {p.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <button type="submit" disabled={creating} className="ds-btn ds-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50">
                {creating ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Link2 className="w-4 h-4" />} Создать ссылку
              </button>
            </form>
            <p className="text-xs text-[var(--text-muted)]">
              Ссылка действует 7 дней и принимается один раз. Права можно поменять и после того, как менеджер войдёт.
            </p>
          </section>

          {fresh && (
            <section role="status" className="ds-card p-5 space-y-3 border border-[var(--warning)]" aria-label="Новая ссылка">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Ссылка{fresh.label ? ` для «${fresh.label}»` : ''} — скопируйте сейчас, второй раз её не показать
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 break-all text-xs text-[var(--text-primary)] bg-[var(--bg-hover)] rounded-lg px-2 py-1.5">{fresh.url}</code>
                <button type="button" onClick={() => void copyLink(fresh.url)} className="ds-btn ds-btn-secondary" aria-label="Скопировать ссылку">
                  <Copy className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => void share(fresh.url)} className="ds-btn ds-btn-secondary" aria-label="Поделиться ссылкой">
                  <Share2 className="w-4 h-4" />
                </button>
              </div>
              {copied === 'ok' && <p className="text-xs text-[var(--success)]">Скопировано</p>}
              {copied === 'fail' && <p className="text-xs text-[var(--danger)]">Браузер не дал скопировать — выделите ссылку и скопируйте вручную</p>}
              {shareNote && <p className="text-xs text-[var(--text-secondary)]">{shareNote}</p>}
              <p className="text-xs text-[var(--text-secondary)]">
                Перешлите её менеджеру любым способом. Он откроет её, войдёт своим аккаунтом Ведара (или зарегистрируется) и
                примет приглашение. Принять может любой, у кого окажется ссылка, — поэтому ниже видно, кто именно принял: чужого
                снимите сразу.
              </p>
              <button type="button" onClick={() => { setFresh(null); setCopied(null); setShareNote(null); }} className="ds-btn ds-btn-secondary">
                Я переслал ссылку
              </button>
            </section>
          )}

          <section className="ds-card p-5 space-y-3" aria-label="Что видит менеджер">
            <h2 className="ds-h2 text-lg">Что видит менеджер</h2>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-[var(--text-secondary)]">Всегда</dt>
                <dd className="text-[var(--text-primary)]">{labelsBy('team').join(', ')}. Обзор и статистика — без выручки.</dd>
              </div>
              <div>
                <dt className="text-[var(--text-secondary)]">С правом «Цены»</dt>
                <dd className="text-[var(--text-primary)]">{labelsBy('can_edit_prices').join(', ')}, создание туров и цены.</dd>
              </div>
              <div>
                <dt className="text-[var(--text-secondary)]">Только вы</dt>
                <dd className="text-[var(--text-primary)]">{labelsBy('owner').join(', ')}; статус «оплачено» у брони.</dd>
              </div>
              {labelsBy('later').length > 0 && (
                <div>
                  <dt className="text-[var(--text-secondary)]">Пока закрыто и менеджеру — откроем следующим шагом</dt>
                  <dd className="text-[var(--text-primary)]">{labelsBy('later').join(', ')}.</dd>
                </div>
              )}
            </dl>
            <p className="text-xs text-[var(--text-muted)]">
              Уведомления о новых заявках и бронях пока приходят только вам — менеджерам добавим отдельным шагом.
            </p>
          </section>

          {load.kind === 'loading' ? (
            <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> Читаем команду…
            </p>
          ) : (
            <>
              <section className="ds-card p-5 space-y-3" aria-label="Менеджеры">
                <h2 className="ds-h2 text-lg">Менеджеры</h2>
                {active.length === 0 ? (
                  <p className="text-sm text-[var(--text-secondary)]">
                    Пока никого. Создайте ссылку выше и перешлите её менеджеру.
                  </p>
                ) : (
                  <ul className="divide-y divide-[var(--border)]">
                    {active.map(m => (
                      <li key={m.id} className="py-3 space-y-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[var(--text-primary)]">{m.user_name || 'Имя в аккаунте не указано'}</p>
                            <p className="text-xs text-[var(--text-secondary)] break-all">
                              {m.user_email || 'почта не указана'}{m.label ? ` · ${m.label}` : ''}
                            </p>
                          </div>
                          <span className="text-xs text-[var(--text-muted)]">в команде с {day(m.accepted_at)}</span>
                        </div>
                        {permBoxes(m)}
                        {removeButton(m, 'Снять')}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {invited.length > 0 && (
                <section className="ds-card p-5 space-y-3" aria-label="Ссылки ждут принятия">
                  <h2 className="ds-h2 text-lg">Ссылки ждут принятия</h2>
                  <ul className="divide-y divide-[var(--border)]">
                    {invited.map(m => (
                      <li key={m.id} className="py-3 space-y-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-sm text-[var(--text-primary)]">{m.label || 'Ссылка без подписи'}</p>
                          <span className={`text-xs ${m.expired ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>
                            {m.expired ? `срок вышел ${day(m.invite_expires_at)}` : `действует до ${day(m.invite_expires_at)}`}
                          </span>
                        </div>
                        {!m.expired && permBoxes(m)}
                        {removeButton(m, m.expired ? 'Убрать' : 'Отозвать')}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {revoked.length > 0 && (
                <details className="ds-card p-5">
                  <summary className="cursor-pointer text-sm text-[var(--text-secondary)]">Сняты и отозваны ({revoked.length})</summary>
                  <ul className="mt-3 divide-y divide-[var(--border)]">
                    {revoked.map(m => (
                      <li key={m.id} className="py-2 flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm text-[var(--text-primary)]">{m.user_name || m.label || 'Ссылка без подписи'}</span>
                        <span className="text-xs text-[var(--text-muted)]">{day(m.revoked_at)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}

      <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
        <UserPlus className="w-3.5 h-3.5" /> Менеджер входит своим аккаунтом: ваш пароль ему не нужен и не передаётся.
      </p>
    </div>
  );
}
