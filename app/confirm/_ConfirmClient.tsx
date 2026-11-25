'use client';

/**
 * Страница, где человек сам отправляет заявку, которую подготовил ИИ-агент
 * (#3399, п. 4; слово владельца 15.11 «Делай»). Ссылку `/confirm#<токен>`
 * агент получает в ответ на заявку и отдаёт человеку; без нажатия здесь
 * заявки нет.
 *
 * Показывает черновик (что и кому уйдёт), имя и телефон с замаскированными
 * цифрами — чтобы узнать свои, — и тексты согласия тех адресатов, кому уйдут
 * данные (те же, что запишет сервер). Отправка — только с галочкой; второе
 * нажатие ничего не отправит. Исход — словами сервера: «создана» только по
 * признаку успеха.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, Send, CheckCircle2, XCircle } from 'lucide-react';
import { consentWording, PD_CONSENT_POLICY_URL, type PdConsentPurpose } from '@/lib/legal/pd-consent';

type Loaded =
  | { state: 'loading' }
  | { state: 'bad_link' }
  | { state: 'error'; message: string }
  | { state: 'sent' | 'expired' | 'missing' }
  /** Ссылка на отмену или перенос заявки (change_request) — подтверждается на своей странице. */
  | { state: 'change' }
  | { state: 'pending'; draft: string; name: string; phone: string; comment: string; purposes: PdConsentPurpose[]; expiresAt: string };

const GONE_WORDS: Record<'sent' | 'expired' | 'missing', string> = {
  sent: 'Эта заявка уже отправлена. Её состояние — по ссылке, которую страница показала после отправки.',
  expired: 'Ссылка истекла, заявка не отправлена. Попросите помощника собрать её заново — придёт новая ссылка.',
  missing: 'Такой заявки нет. Проверьте, что открыли ссылку целиком, или попросите помощника собрать заявку заново.',
};

/**
 * «до 21:40» — до какого времени действует ссылка, по часам устройства
 * (ссылка живёт час, PENDING_REQUEST_TTL_MIN). Не разобрали дату — строки нет.
 */
export function expiresAtLabel(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Ссылки в тексте ответа — кликабельными, остальное — текстом. */
function TextWithLinks({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/vedarai\.ru\/[^\s,]+)/g);
  return (
    <>
      {parts.map((p, i) => (/^https:\/\/vedarai\.ru\//.test(p)
        ? <a key={i} href={p} className="text-[var(--ocean)] underline break-all">{p}</a>
        : <span key={i}>{p}</span>))}
    </>
  );
}

export function ConfirmClient() {
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Временный отказ (лимит, база не ответила): заявка ещё ждёт — форма остаётся.
  const [sendError, setSendError] = useState<string | null>(null);
  // После отправки форма с кнопкой исчезает — фокус ставим на итог, иначе
  // клавиатура и экранный диктор начинают страницу сначала (проход 25.11).
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => { if (result) resultRef.current?.focus(); }, [result]);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, '').trim();
    if (!/^[A-Za-z0-9_-]{32}$/.test(t)) { setLoaded({ state: 'bad_link' }); return; }
    setToken(t);
    fetch('/api/requests/pending', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) })
      .then(async (r) => {
        const j = await r.json().catch(() => null) as { success?: boolean; error?: string; data?: Record<string, unknown> } | null;
        if (!r.ok || !j?.success || !j.data) { setLoaded({ state: 'error', message: j?.error ?? 'Не удалось загрузить заявку, попробуйте через минуту' }); return; }
        const d = j.data;
        if (d.state === 'pending' && d.kind === 'change') { setLoaded({ state: 'change' }); return; }
        if (d.state === 'pending') {
          setLoaded({
            state: 'pending', draft: String(d.draft ?? ''), name: String(d.name ?? ''), phone: String(d.phone ?? ''), comment: String(d.comment ?? ''),
            purposes: (Array.isArray(d.consent_purposes) ? d.consent_purposes : ['operator']) as PdConsentPurpose[],
            expiresAt: String(d.expires_at ?? ''),
          });
        } else if (d.state === 'sent' || d.state === 'expired' || d.state === 'missing') setLoaded({ state: d.state });
        else setLoaded({ state: 'error', message: 'Не удалось загрузить заявку, попробуйте через минуту' });
      })
      .catch(() => setLoaded({ state: 'error', message: 'Нет связи с Ведаром. Проверьте интернет и обновите страницу.' }));
  }, []);

  async function send() {
    if (!token || !consent || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await fetch('/api/requests/pending/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, pd_consent: consent }),
      });
      const j = await r.json().catch(() => null) as { success?: boolean; error?: string; data?: { created?: boolean; text?: string } } | null;
      if (r.ok && j?.success && j.data?.text) setResult({ ok: j.data.created === true, text: j.data.text });
      else if (r.status === 503) setSendError(j?.error ?? 'Не удалось отправить заявку — она ещё ждёт. Нажмите «Отправить» через минуту.');
      else setResult({ ok: false, text: j?.error ?? 'Не удалось отправить заявку, попробуйте через минуту.' });
    } catch {
      setSendError('Нет связи с Ведаром — заявка не отправлена. Проверьте интернет и нажмите ещё раз.');
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="ds-page min-h-screen px-4 py-10">
      <div className="mx-auto max-w-xl space-y-5">
        <h1 className="ds-h1 font-playfair">Отправить заявку</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Заявку подготовил ваш ИИ-помощник. Она уйдёт адресату, только когда вы нажмёте «Отправить» на этой странице.
        </p>

        {loaded.state === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]" role="status">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Загружаю заявку…
          </p>
        )}
        {loaded.state === 'bad_link' && (
          <p className="ds-card p-4 text-sm text-[var(--text-primary)]">Ссылка неполная. Откройте её целиком из сообщения помощника.</p>
        )}
        {loaded.state === 'error' && (
          <p className="ds-card p-4 text-sm text-[var(--text-primary)]" role="alert">{loaded.message}</p>
        )}
        {(loaded.state === 'sent' || loaded.state === 'expired' || loaded.state === 'missing') && (
          <p className="ds-card p-4 text-sm text-[var(--text-primary)]">{GONE_WORDS[loaded.state]}</p>
        )}
        {loaded.state === 'change' && token && (
          <p className="ds-card p-4 text-sm text-[var(--text-primary)]">
            Это ссылка на изменение заявки, а не на новую заявку.{' '}
            <a href={`/confirm/change#${token}`} className="text-[var(--ocean)] underline">Открыть страницу подтверждения изменения</a>.
          </p>
        )}

        {loaded.state === 'pending' && !result && (
          <section className="ds-card p-5 space-y-4" aria-label="Заявка">
            <p className="text-sm leading-relaxed text-[var(--text-primary)]">{loaded.draft}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-[var(--text-secondary)]">Имя</dt><dd className="text-[var(--text-primary)]">{loaded.name || 'не указано'}</dd>
              <dt className="text-[var(--text-secondary)]">Телефон</dt><dd className="text-[var(--text-primary)]">{loaded.phone}</dd>
              {loaded.comment && (<>
                <dt className="text-[var(--text-secondary)]">Комментарий</dt>
                <dd className="text-[var(--text-primary)] whitespace-pre-line break-words">{loaded.comment}</dd>
              </>)}
            </dl>
            <p className="text-xs text-[var(--text-secondary)]">
              Имя, телефон или комментарий не ваши — не отправляйте: попросите помощника собрать заявку заново.
            </p>
            {expiresAtLabel(loaded.expiresAt) && (
              <p className="text-xs text-[var(--text-secondary)]">Ссылка действует до {expiresAtLabel(loaded.expiresAt)}. Потом заявку придётся собрать заново.</p>
            )}
            <label htmlFor="confirm-consent" className="flex items-start gap-3 min-h-[44px] py-2 cursor-pointer text-xs leading-relaxed text-[var(--text-secondary)]">
              <input id="confirm-consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
                className="w-5 h-5 shrink-0 accent-[var(--accent)]" />
              <span>
                {loaded.purposes.map((p) => consentWording(p).text).join('; ')} в соответствии с{' '}
                <a href={PD_CONSENT_POLICY_URL} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] hover:underline">политикой конфиденциальности</a>.
              </span>
            </label>
            <button type="button" onClick={send} disabled={!consent || sending}
              aria-describedby={!consent ? 'confirm-consent-hint' : undefined}
              className="ds-btn ds-btn-primary w-full inline-flex items-center justify-center gap-2 disabled:opacity-50">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Send className="w-4 h-4" aria-hidden />}
              {sending ? 'Отправляю…' : 'Отправить'}
            </button>
            {/* Бледная кнопка без слов не объясняла, почему не жмётся (проход 25.11). */}
            {!consent && (
              <p id="confirm-consent-hint" className="text-sm text-[var(--text-primary)]">Отметьте согласие выше, чтобы отправить.</p>
            )}
            {sendError && <p className="text-sm text-[var(--text-primary)]" role="alert">{sendError}</p>}
            <p className="text-xs text-[var(--text-secondary)]">
              Это заявка, не бронь: её подтверждает человек на стороне исполнителя, мгновенной брони нет. Оплаты через платформу нет.
            </p>
          </section>
        )}

        {result && (
          <section ref={resultRef} tabIndex={-1} className="ds-card p-5 space-y-3 outline-none" role="status">
            <p className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
              {result.ok
                ? <CheckCircle2 className="w-5 h-5 text-[var(--success)]" aria-hidden />
                : <XCircle className="w-5 h-5 text-[var(--warning)]" aria-hidden />}
              {result.ok ? 'Заявка отправлена' : 'Заявка не отправлена'}
            </p>
            <p className="text-sm leading-relaxed whitespace-pre-line text-[var(--text-primary)]"><TextWithLinks text={result.text} /></p>
          </section>
        )}

        <p className="text-xs text-[var(--text-secondary)]">
          <Link href="/" className="text-[var(--ocean)] hover:underline">Ведар</Link> — независимая платформа для туристов Камчатки. Экстренный вызов — 112.
        </p>
      </div>
    </main>
  );
}
