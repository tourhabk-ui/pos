'use client';

/**
 * /request-resume#<ключ> — кнопка «Отправить заявку» из единственного
 * напоминания. Ключ в #, а не в адресе: он не уходит в логи сервера.
 * Показывает текст пожелания и ведёт на /request с ним; заявку отправляет
 * сам человек, подтверждает человек-партнёр, оплаты через платформу нет.
 * Здесь же — «Больше не напоминать» (отзыв согласия на повторный контакт).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

const RESUME_STORAGE_KEY = 'vedar-request-resume';

type Loaded = { comment: string | null; title: string | null; submitted: boolean; withdrawn: boolean };

export default function ResumeClient() {
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [withdrawn, setWithdrawn] = useState(false);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) { setState('missing'); return; }
    setToken(t);
    fetch('/api/request-drafts/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t, action: 'read' }) })
      .then(async r => {
        if (r.status === 404 || r.status === 400) { setState('missing'); return; }
        const j = await r.json();
        if (!r.ok || !j.success) { setState('error'); return; }
        setData(j); setWithdrawn(!!j.withdrawn); setState('ready');
      })
      .catch(() => setState('error'));
  }, []);

  const go = () => {
    if (!token || !data) return;
    try { sessionStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify({ token, comment: data.comment ?? '' })); } catch (e) { logSwallowedFailure('request-resume', 'запись в sessionStorage', e); }
    window.location.href = '/request';
  };

  const withdraw = async () => {
    if (!token) return;
    const r = await fetch('/api/request-drafts/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, action: 'withdraw' }) }).catch(() => null);
    if (r?.ok) setWithdrawn(true);
  };

  return (
    <main className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] px-4 py-16">
      <div className="max-w-lg mx-auto space-y-5">
        <h1 className="text-2xl font-semibold">Вернуться к заявке</h1>
        {state === 'loading' && <p className="text-sm text-[var(--text-secondary)]">Загружаем…</p>}
        {state === 'missing' && (
          <p className="text-sm text-[var(--text-secondary)]">Ссылка не найдена. Можно <Link href="/request" className="text-[var(--ocean)] hover:underline">оставить заявку заново</Link>.</p>
        )}
        {state === 'error' && <p className="text-sm text-[var(--text-secondary)]">Не получилось открыть заявку. Обновите страницу через минуту.</p>}
        {state === 'ready' && data && (
          <>
            {data.submitted ? (
              <p className="text-sm text-[var(--text-secondary)]">Эта заявка уже отправлена — ждём подтверждения людьми.</p>
            ) : (
              <>
                {data.title && <p className="text-sm">«{data.title}»</p>}
                {data.comment && <blockquote className="text-sm border-l-2 border-[var(--border)] pl-3 whitespace-pre-wrap">{data.comment}</blockquote>}
                <p className="text-sm text-[var(--text-secondary)]">Заявку отправляете вы; её подтвердит человек. Оплаты через платформу нет.</p>
                <button onClick={go} className="w-full py-3 rounded-lg bg-[var(--accent)] text-white font-medium">Отправить заявку</button>
              </>
            )}
            {withdrawn ? (
              <p className="text-xs text-[var(--text-secondary)]">Согласие на напоминания отозвано — больше не напомним.</p>
            ) : (
              <button onClick={withdraw} className="text-xs text-[var(--text-secondary)] underline">Больше не напоминать (отозвать согласие)</button>
            )}
          </>
        )}
      </div>
    </main>
  );
}
