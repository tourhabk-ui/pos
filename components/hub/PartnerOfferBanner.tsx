'use client';

/**
 * «Примите оферту» — просьба при входе в кабинет партнёра (слово владельца
 * 24.11: «Партнёры, заведённые до оферты, принимают её при следующем входе в
 * кабинет, до сезона»).
 *
 * До этого дня принять оферту можно было только пунктом чек-листа на главной
 * кабинета, с подписью «не обязательно»: партнёр, который открывает сразу
 * «Входящие», его не видел вовсе. Плашка стоит в layout кабинета каждой роли
 * с заявками — оператор, гид, жильё, снаряжение, перевозчик и прокат.
 *
 * Чего плашка НЕ делает:
 *  - кабинет не запирает: у «до сезона» нет даты, а заявки партнёру идут и
 *    без отметки. «Позже» прячет её до конца сессии вкладки — при следующем
 *    входе просьба появится снова;
 *  - менеджеру команды кнопку не даёт: за компанию принимает владелец;
 *  - на сбое проверки молчит: «не принята» там, где журнал не прочитался,
 *    было бы выдумкой (§4.0).
 *
 * Принятие — та же форма, что в чек-листе (`OfferAcceptForm`), и та же дверь.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, FileText, X } from 'lucide-react';
import { OfferAcceptForm } from '@/components/legal/OfferAcceptForm';
import { OFFER_ASK_STATES, OFFER_EDITION, OFFER_URL, offerAskWords, type OfferAskState } from '@/lib/legal/offer';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

interface Ask {
  state: OfferAskState;
  previous: boolean;
}

function readAsk(json: unknown): Ask | null {
  if (!json || typeof json !== 'object' || (json as { success?: unknown }).success !== true) return null;
  const d = (json as { data?: unknown }).data;
  if (!d || typeof d !== 'object') return null;
  const { state, previous } = d as { state?: unknown; previous?: unknown };
  return OFFER_ASK_STATES.includes(state as OfferAskState)
    ? { state: state as OfferAskState, previous: previous === true }
    : null;
}

// Скрытие — только до конца сессии вкладки и только для действующей редакции:
// вышла новая — просьба показывается заново.
const LATER_KEY = `vedar.partner-offer-banner.later.${OFFER_EDITION}`;

function hiddenForSession(): boolean {
  try {
    return window.sessionStorage.getItem(LATER_KEY) === '1';
  } catch {
    // Хранилище недоступно — «не скрыто»: лишний показ честнее молчания.
    return false;
  }
}

export function PartnerOfferBanner() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [later, setLater] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/hub/partner/offer', { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        const got = res.ok ? readAsk(await res.json().catch(() => null)) : null;
        if (ctrl.signal.aborted || !got) return;
        setLater(hiddenForSession());
        setAsk(got);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);

  if (accepted) {
    return (
      <div role="status" data-testid="partner-offer-banner" data-state="accepted"
        className="mx-3 mt-3 min-w-0 max-w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2">
        <p className="flex items-center gap-2 min-h-[44px] text-sm text-[var(--text-primary)]">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
          {/* Редакция кончается на «г.» — второй точки после неё не ставим. */}
          Оферта принята: редакция от {OFFER_EDITION} Отметка записана.
        </p>
      </div>
    );
  }
  if (!ask || (ask.state !== 'needed' && ask.state !== 'owner_only') || later) return null;

  function hide() {
    setLater(true);
    try {
      window.sessionStorage.setItem(LATER_KEY, '1');
    } catch (err) {
      logSwallowedFailure('partner-offer-banner', 'сохранение «позже»', err);
    }
  }

  return (
    <div role="status" data-testid="partner-offer-banner" data-state={ask.state}
      className="mx-3 mt-3 min-w-0 max-w-full rounded-lg border border-[var(--warning)] bg-[var(--bg-card)] px-3 py-2">
      <div className="flex items-start gap-2 min-w-0">
        <FileText className="w-4 h-4 mt-3.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
        <p className="flex-1 min-w-0 py-2.5 text-sm text-[var(--text-primary)] break-words">
          {offerAskWords(ask.state, ask.previous)}{' '}
          <a href={OFFER_URL} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] hover:underline">
            Читать оферту
          </a>
        </p>
        <button
          type="button"
          onClick={hide}
          aria-label="Позже: скрыть просьбу до следующего входа"
          className="shrink-0 inline-flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-200"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      {ask.state === 'needed' && (
        <div className="pl-6 pb-1">
          <OfferAcceptForm id="banner-offer-accept" onDone={() => setAccepted(true)} />
        </div>
      )}
    </div>
  );
}
