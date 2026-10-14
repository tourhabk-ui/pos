'use client';

/**
 * Страница заявки для человека (вторая половина ступени 1 агентного контура,
 * #2371, 12.10). Ключ — во фрагменте адреса (`/request-status#<ключ>`), как у
 * `/seat-request`: на сервер, в Referer и в метрику просмотров он не уходит.
 *
 * Показывает то же, что агенту даёт get_request_status, — состояние и ответ
 * оператора без имени и телефона (они человеку известны), — и даёт поставить
 * согласие на обработку ПД своей рукой: до этого в заявке стоит утверждение
 * агента (`consent: true` в вызове инструмента), а не галочка человека (долг
 * в шапке lib/mcp/write-guard.ts). Пока заявка ждёт оператора, страница
 * переспрашивает состояние сама; «ссылка неверна» / «не найдена» окончательны.
 *
 * Заявка на жильё (14.10): своего ответа у неё нет — владелец звонит гостю
 * сам, и страница говорит «передана», не обещая ответа и не переспрашивая.
 * Галочка — тем текстом, кому уходят данные (`consent_purpose`): владельцу
 * жилья, перевозчику или туроператору; тот же текст записывает сервер.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, CheckCircle2, XCircle, CalendarClock, Clock, AlertTriangle, ShieldCheck, PhoneCall } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { platformAcceptsPayments } from '@/lib/payments/accepting';
import {
  REQUEST_KEY_MIN_CHARS, REQUEST_KEY_MAX_CHARS, type RequestState, type RequestKind, type ConsentPurpose,
} from '@/lib/mcp/request-status-schema';

type ConsentBy = 'human' | 'agent' | 'none';

interface View {
  state: RequestState;
  kind: RequestKind;
  tour: string | null;
  accommodation: string | null;
  accommodation_url: string | null;
  date: string | null;
  check_out: string | null;
  participants: number | null;
  alt_date: string | null;
  deadline: string | null;
  human: string;
  consent: ConsentBy;
  consent_purpose: ConsentPurpose;
}

interface StateText { title: string; tone: string; next: string }

const TEXT: Record<RequestState, StateText> = {
  awaiting_operator: { title: 'Ждём ответа оператора', tone: 'var(--ocean)', next: 'Оператор свяжется по телефону из заявки. Страница обновится сама, когда ответ появится.' },
  delivered: { title: 'Заявка передана', tone: 'var(--ocean)', next: 'Ответ дают звонком по телефону из заявки, и платформа его не видит.' },
  operator_contacted: { title: 'Оператор связался с вами', tone: 'var(--ocean)', next: 'Дальнейшее согласуйте с оператором по телефону.' },
  in_progress: { title: 'Заявка в работе у оператора', tone: 'var(--ocean)', next: 'Оператор уточняет детали. Дальнейшее согласуйте с ним по телефону.' },
  confirmed: { title: 'Оператор подтвердил заявку', tone: 'var(--success)', next: '' },
  declined: { title: 'Оператор отказал по заявке', tone: 'var(--text-secondary)', next: 'Можно выбрать другой тур или дату в каталоге.' },
  other_date: { title: 'Оператор предлагает другую дату', tone: 'var(--warning)', next: 'Если дата подходит, подтвердите её оператору по телефону; иначе выберите другой тур или дату.' },
  no_answer: { title: 'Оператор не ответил в срок', tone: 'var(--warning)', next: 'Это не значит, что мест нет: оставьте заявку на карточке тура, и менеджер свяжется с оператором сам.' },
  cancelled: { title: 'Бронь по заявке отменена', tone: 'var(--text-secondary)', next: 'Можно оставить новую заявку в каталоге.' },
  failed: { title: 'Ответ оператора не записался', tone: 'var(--danger)', next: 'Свяжитесь с оператором напрямую или оставьте заявку на карточке тура.' },
  unknown: { title: 'Состояние заявки не распознано', tone: 'var(--danger)', next: 'Свяжитесь с оператором напрямую или оставьте заявку на карточке тура.' },
};

/**
 * Заявка на жильё: у неё бывают только «передана», «не дошла» и «не
 * записано, куда дошла» — и говорят они о владельце, а не об операторе.
 */
const STAY_TEXT: Partial<Record<RequestState, StateText>> = {
  delivered: { title: 'Заявка передана', tone: 'var(--ocean)', next: 'Владелец позвонит по телефону из заявки и подтвердит даты и цену; его ответа платформа не видит. Если звонка долго нет, позвоните сами: телефон на карточке объекта.' },
  failed: { title: 'Заявка не дошла до владельца', tone: 'var(--danger)', next: 'Позвоните владельцу сами: телефон на карточке объекта.' },
  unknown: { title: 'Не записано, куда дошла заявка', tone: 'var(--warning)', next: 'Если владелец не позвонил, позвоните ему сами: телефон на карточке объекта.' },
};

function textFor(view: Pick<View, 'state' | 'kind'>): StateText {
  return (view.kind === 'stay_request' ? STAY_TEXT[view.state] : undefined) ?? TEXT[view.state];
}

function nextText(view: Pick<View, 'state' | 'kind'>): string {
  if (view.state === 'confirmed') {
    return platformAcceptsPayments()
      ? 'Оператор скажет, как оплатить.'
      : 'Оплата — оператору напрямую, он скажет как. Через платформу оплаты нет.';
  }
  return textFor(view).next;
}

function Icon({ view }: { view: Pick<View, 'state' | 'kind'> }) {
  const s = view.state;
  const cls = 'w-6 h-6 shrink-0';
  const style = { color: textFor(view).tone };
  if (s === 'delivered') return <PhoneCall className={cls} style={style} />;
  if (s === 'awaiting_operator' || s === 'operator_contacted' || s === 'in_progress') return <Clock className={cls} style={style} />;
  if (s === 'confirmed') return <CheckCircle2 className={cls} style={style} />;
  if (s === 'declined' || s === 'cancelled') return <XCircle className={cls} style={style} />;
  if (s === 'other_date') return <CalendarClock className={cls} style={style} />;
  return <AlertTriangle className={cls} style={style} />;
}

const KEY_RE = new RegExp(`^[A-Za-z0-9_-]{${REQUEST_KEY_MIN_CHARS},${REQUEST_KEY_MAX_CHARS}}$`);

/** Что показать вместо «Пробуем ещё раз»: у неверной ссылки повтор смысла не имеет. */
const FATAL_TEXT: Record<400 | 404, string> = {
  400: 'Ссылка на заявку повреждена. Откройте её целиком — ту, что дал помощник.',
  404: 'Заявка по этой ссылке не найдена или ссылка истекла (она живёт 90 дней). Возможно, ссылку скопировали не полностью.',
};

function readKeyFromHash(): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  return KEY_RE.test(raw) ? raw : null;
}

function dateRu(value: string | null): string | null {
  if (!value) return null;
  const t = new Date(`${value}T00:00:00`);
  return Number.isNaN(t.getTime()) ? value : t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function RequestStatusClient() {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Окончательный отказ (400/404): опрос останавливается.
  const [fatal, setFatal] = useState<string | null>(null);
  // Какой ключ страница показывает сейчас: ответ на прежний ключ, пришедший
  // после смены адреса, не должен затирать состояние новой заявки.
  const activeKey = useRef<string | null>(null);

  const [pdConsent, setPdConsent] = useState(false);
  const [consentState, setConsentState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [consentError, setConsentError] = useState<string | null>(null);

  // Ключ читается из фрагмента после монтирования: на сервере его нет по
  // построению. undefined — ещё не читали, null — в адресе ключа нет.
  useEffect(() => {
    const apply = () => {
      const next = readKeyFromHash();
      activeKey.current = next;
      setView(null);
      setError(null);
      setFatal(null);
      setConsentState('idle');
      setConsentError(null);
      setKey(next);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  const load = useCallback(async () => {
    if (!key) return;
    const asked = key;
    try {
      const res = await fetch(`/api/requests/status?k=${encodeURIComponent(asked)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null) as { success: true; data: View } | { success: false; error?: string } | null;
      if (activeKey.current !== asked) return;
      if (res.status === 400 || res.status === 404) {
        setFatal(FATAL_TEXT[res.status]);
        return;
      }
      if (!res.ok || !body || !body.success) {
        setError((body && !body.success && body.error) || `Сервер ответил ${res.status}`);
        return;
      }
      setError(null);
      setView(body.data);
    } catch {
      if (activeKey.current !== asked) return;
      setError('Нет связи с сервером.');
    }
  }, [key]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- первая загрузка по ключу из адреса: источника до монтирования нет
    void load();
  }, [load]);

  // Пока заявка ждёт — переспрашиваем. Пока первая загрузка не удалась
  // (view нет, ошибка есть) — тоже: один сбой сети не должен оставлять
  // страницу навсегда на ошибке.
  useEffect(() => {
    const keepPolling = view?.state === 'awaiting_operator' || (view === null && error !== null);
    if (!key || fatal || !keepPolling) return;
    const t = setInterval(() => { void load(); }, view === null ? 10_000 : 60_000);
    return () => clearInterval(t);
  }, [key, view, error, fatal, load]);

  const confirm = useCallback(async () => {
    if (!key || !pdConsent) return;
    const asked = key;
    setConsentState('sending');
    setConsentError(null);
    try {
      const res = await fetch('/api/requests/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: asked, pd_consent: pdConsent }),
      });
      const body = await res.json().catch(() => null) as { success: boolean; error?: string } | null;
      if (activeKey.current !== asked) return;
      if (!res.ok || !body || !body.success) {
        setConsentState('idle');
        setConsentError((body && body.error) || `Сервер ответил ${res.status}`);
        return;
      }
      setConsentState('done');
      setView((v) => (v ? { ...v, consent: 'human' } : v));
    } catch {
      if (activeKey.current !== asked) return;
      setConsentState('idle');
      setConsentError('Нет связи с сервером.');
    }
  }, [key, pdConsent]);

  if (key === undefined) {
    return <main className="ds-page min-h-screen" />;
  }

  const details = !view ? ''
    : view.kind === 'stay_request'
      ? [
        view.accommodation,
        view.date && view.check_out ? `${dateRu(view.date)} — ${dateRu(view.check_out)}` : dateRu(view.date),
        view.participants ? `гостей: ${view.participants}` : null,
      ].filter(Boolean).join(' · ')
      : [view.tour, dateRu(view.date), view.participants ? `${view.participants} чел.` : null].filter(Boolean).join(' · ');

  return (
    <main className="ds-page min-h-screen px-4 py-10">
      <div className="max-w-md mx-auto space-y-4">
        {key === null && (
          <div className="ds-card p-6 space-y-2">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>Ссылка не полная</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              В адресе нет ключа заявки. Откройте ссылку целиком — ту, что дал помощник после отправки заявки.
            </p>
            <Link href="/catalog" className="text-sm text-[var(--ocean)] hover:underline">К турам</Link>
          </div>
        )}
        {fatal && (
          <div className="ds-card p-6 space-y-2" role="alert">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>Заявка не открылась</h1>
            <p className="text-sm text-[var(--text-secondary)]">{fatal}</p>
            <Link href="/catalog" className="text-sm text-[var(--ocean)] hover:underline">К турам</Link>
          </div>
        )}
        {key !== null && !fatal && !view && !error && (
          <div className="ds-card p-6 flex items-center gap-2 text-[var(--text-secondary)]">
            <Loader2 className="w-4 h-4 animate-spin" /> Проверяем состояние заявки…
          </div>
        )}
        {error && !fatal && (
          <p className="text-sm text-[var(--danger)]" role="alert">
            {view ? `${error} Показано последнее известное состояние.` : `${error} Пробуем ещё раз…`}
          </p>
        )}
        {view && (
          <div className="ds-card p-6 space-y-4" aria-live="polite">
            <div className="flex items-start gap-3">
              <Icon view={view} />
              <div>
                <h1 className="text-2xl font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
                  {textFor(view).title}
                </h1>
                {details && <p className="text-sm text-[var(--text-secondary)] mt-1">{details}</p>}
              </div>
            </div>

            <p className="text-sm text-[var(--text-primary)]">{view.human}</p>
            {view.state === 'awaiting_operator' && view.deadline && (
              <p className="text-sm text-[var(--text-secondary)]">
                Оператор ответит до {new Date(view.deadline).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.
              </p>
            )}
            {view.state === 'other_date' && view.alt_date && (
              <p className="text-sm text-[var(--text-primary)]">Предложенная дата: <b>{dateRu(view.alt_date)}</b>.</p>
            )}
            <p className="text-sm text-[var(--text-secondary)]">{nextText(view)}</p>

            {view.consent !== 'human' ? (
              <div className="space-y-2 pt-3 border-t border-[var(--border)]">
                <p className="text-sm text-[var(--text-primary)] flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--ocean)' }} />
                  <span>
                    {view.consent === 'agent'
                      ? 'Согласие на обработку данных за вас передал помощник. Подтвердите его сами: тогда заявка держится на вашей галочке, а не на словах программы.'
                      : 'Согласие на обработку данных по этой заявке не записано. Поставьте его сами.'}
                  </span>
                </p>
                <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="request-pd-consent" purpose={view.consent_purpose} />
                <button
                  type="button"
                  className="ds-btn ds-btn-primary w-full"
                  disabled={!pdConsent || consentState === 'sending'}
                  onClick={() => void confirm()}
                >
                  {consentState === 'sending' ? 'Записываем…' : 'Подтвердить согласие'}
                </button>
                {consentError && <p className="text-sm text-[var(--danger)]" role="alert">{consentError}</p>}
              </div>
            ) : (
              <p className="text-sm flex items-center gap-2 pt-3 border-t border-[var(--border)]" style={{ color: 'var(--success)' }}>
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>{consentState === 'done' ? 'Согласие записано.' : 'Согласие на обработку данных подтверждено вами.'}</span>
              </p>
            )}

            <div className="flex flex-wrap gap-3 text-sm">
              {view.kind === 'stay_request' ? (
                <>
                  {view.accommodation_url && (
                    <a href={view.accommodation_url} className="text-[var(--ocean)] hover:underline">Карточка объекта</a>
                  )}
                  <Link href="/accommodations" className="text-[var(--ocean)] hover:underline">Жильё</Link>
                </>
              ) : (
                <Link href="/catalog" className="text-[var(--ocean)] hover:underline">Каталог туров</Link>
              )}
              <Link href="/legal/privacy" className="text-[var(--ocean)] hover:underline">Политика конфиденциальности</Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
