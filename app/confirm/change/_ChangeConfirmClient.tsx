'use client';

/**
 * Страница, где человек сам подтверждает отмену или перенос своей заявки,
 * которые подготовил ИИ-агент (change_request; слово владельца 20.11 «1 для
 * всех агентов», #3573). Ссылку `/confirm/change#<токен>` агент получает в
 * ответ на вызов и отдаёт человеку; без нажатия здесь заявка не меняется.
 *
 * Показывает, что произойдёт после подтверждения (те же слова, что агенту);
 * имени, телефона и согласия здесь нет — меняется своя заявка, ничьи данные
 * никуда не уходят. Исход — словами сервера: «изменена» только по признаку.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

type Loaded =
  | { state: 'loading' }
  | { state: 'bad_link' }
  | { state: 'error'; message: string }
  | { state: 'sent' | 'expired' | 'missing' }
  /** Ссылка на новую заявку, а не на изменение, — её отправляют на /confirm. */
  | { state: 'request' }
  | { state: 'pending'; draft: string };

const GONE_WORDS: Record<'sent' | 'expired' | 'missing', string> = {
  sent: 'Это изменение уже подтверждено. Состояние заявки покажет ваш помощник или страница заявки.',
  expired: 'Ссылка истекла, заявка не изменена. Если изменение ещё нужно, попросите помощника подготовить ссылку заново.',
  missing: 'Такой ссылки нет. Проверьте, что открыли её целиком, или попросите помощника подготовить ссылку заново.',
};

export function ChangeConfirmClient() {
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ changed: boolean; requested: boolean; text: string } | null>(null);
  // Временный отказ (лимит, база не ответила): ссылка ещё действует — кнопка остаётся.
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, '').trim();
    if (!/^[A-Za-z0-9_-]{32}$/.test(t)) { setLoaded({ state: 'bad_link' }); return; }
    setToken(t);
    fetch('/api/requests/pending', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) })
      .then(async (r) => {
        const j = await r.json().catch(() => null) as { success?: boolean; error?: string; data?: Record<string, unknown> } | null;
        if (!r.ok || !j?.success || !j.data) { setLoaded({ state: 'error', message: j?.error ?? 'Не удалось загрузить, попробуйте через минуту' }); return; }
        const d = j.data;
        if (d.state === 'pending' && d.kind === 'change') setLoaded({ state: 'pending', draft: String(d.draft ?? '') });
        else if (d.state === 'pending') setLoaded({ state: 'request' });
        else if (d.state === 'sent' || d.state === 'expired' || d.state === 'missing') setLoaded({ state: d.state });
        else setLoaded({ state: 'error', message: 'Не удалось загрузить, попробуйте через минуту' });
      })
      .catch(() => setLoaded({ state: 'error', message: 'Нет связи с Ведаром. Проверьте интернет и обновите страницу.' }));
  }, []);

  async function confirm() {
    if (!token || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await fetch('/api/requests/pending/change', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      const j = await r.json().catch(() => null) as { success?: boolean; error?: string; data?: { changed?: boolean; outcome?: string; text?: string } } | null;
      // «Просьба передана» — заявка не изменена, но и не «ничего не вышло»: решает оператор.
      if (r.ok && j?.success && j.data?.text) setResult({ changed: j.data.changed === true, requested: j.data.outcome === 'cancel_requested' || j.data.outcome === 'date_change_requested', text: j.data.text });
      else if (r.status === 503 || r.status === 429) setSendError(j?.error ?? 'Не удалось подтвердить — ссылка ещё действует. Нажмите «Подтвердить» через минуту.');
      else setResult({ changed: false, requested: false, text: j?.error ?? 'Не удалось подтвердить, попробуйте через минуту.' });
    } catch {
      setSendError('Нет связи с Ведаром — заявка не изменена. Проверьте интернет и нажмите ещё раз.');
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="ds-page min-h-screen px-4 py-10">
      <div className="mx-auto max-w-xl space-y-5">
        <h1 className="ds-h1 font-playfair">Изменить заявку</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Изменение подготовил ваш ИИ-помощник. Заявка изменится, только когда вы нажмёте «Подтвердить» на этой странице.
        </p>

        {loaded.state === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]" role="status">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Загружаю…
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
        {loaded.state === 'request' && token && (
          <p className="ds-card p-4 text-sm text-[var(--text-primary)]">
            Это ссылка на новую заявку, а не на изменение.{' '}
            <a href={`/confirm#${token}`} className="text-[var(--ocean)] underline">Открыть страницу отправки заявки</a>.
          </p>
        )}

        {loaded.state === 'pending' && !result && (
          <section className="ds-card p-5 space-y-4" aria-label="Изменение заявки">
            <p className="text-sm leading-relaxed text-[var(--text-primary)]">{loaded.draft}</p>
            <p className="text-xs text-[var(--text-secondary)]">
              Не просили об этом — не подтверждайте: закройте страницу, заявка останется как есть.
            </p>
            <button type="button" onClick={confirm} disabled={sending}
              className="ds-btn ds-btn-primary w-full inline-flex items-center justify-center gap-2 disabled:opacity-50">
              {sending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {sending ? 'Подтверждаю…' : 'Подтвердить'}
            </button>
            {sendError && <p className="text-sm text-[var(--text-primary)]" role="alert">{sendError}</p>}
            <p className="text-xs text-[var(--text-secondary)]">
              Заявка — не бронь: её подтверждает исполнитель. Отменённую заявку вернуть нельзя.
            </p>
          </section>
        )}

        {result && (
          <section className="ds-card p-5 space-y-3" role="status">
            <p className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
              {result.changed || result.requested
                ? <CheckCircle2 className="w-5 h-5 text-[var(--success)]" aria-hidden />
                : <XCircle className="w-5 h-5 text-[var(--warning)]" aria-hidden />}
              {result.changed ? 'Заявка изменена' : result.requested ? 'Просьба передана' : 'Заявка не изменена'}
            </p>
            <p className="text-sm leading-relaxed whitespace-pre-line text-[var(--text-primary)]">{result.text}</p>
          </section>
        )}

        <p className="text-xs text-[var(--text-secondary)]">
          <Link href="/" className="text-[var(--ocean)] hover:underline">Ведар</Link> — независимая платформа для туристов Камчатки. Экстренный вызов — 112.
        </p>
      </div>
    </main>
  );
}
