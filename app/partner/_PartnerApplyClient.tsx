'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { BUSINESS_TYPES } from '@/lib/partners/application';
import { PD_CONSENT_PARTNER_APPLY_TEXT, PD_CONSENT_POLICY_URL } from '@/lib/legal/pd-consent';

const WHO = [
  'Туроператоры и экскурсии',
  'Рыбалка',
  'Гостевые дома и базы',
  'Прокат автомобилей',
  'Трансферы',
  'Гиды',
];

const GETS = [
  'Заявки с сайта vedarai.ru и от ИИ-помощников, которые подключаются к нашему каталогу (MCP)',
  'Ответ на заявку кнопками в MAX или Telegram: «Есть», «Нет», «Другая дата»',
  'Голосом: свободные даты и места, бот показывает, что понял, и ждёт подтверждения',
  'Сводка по заявкам одной командой',
  'Оплату туристы вносят вам напрямую, комиссии сейчас нет',
];

const INP = 'w-full px-3.5 py-3 text-base bg-white border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]';
const LBL = 'block text-sm font-medium text-[var(--text-primary)] mb-1.5';

export default function PartnerApplyClient() {
  const [form, setForm] = useState({
    company: '', business_type: '', contact_name: '', contact: '', wants: '', website: '', pd_consent: false,
  });
  const [utm, setUtm] = useState<Record<string, string>>({});
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const u: Record<string, string> = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      const v = p.get(k);
      if (v) u[k] = v.slice(0, 100);
    }
    setUtm(u);
  }, []);

  const set = (k: keyof typeof form, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.pd_consent) { setError('Необходимо согласие на обработку персональных данных'); return; }
    setState('sending'); setError('');
    try {
      const res = await fetch('/api/partner-applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, wants: form.wants || undefined, utm, pd_consent: true }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Не удалось отправить заявку');
      setState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить заявку');
      setState('idle');
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 sm:py-12 grid lg:grid-cols-2 gap-8 lg:gap-12 items-start">
      <section className="space-y-6">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold leading-tight">
            Подключите свой бизнес <span style={{ color: 'var(--accent)' }}>к Ведару</span>
          </h1>
          <p className="mt-3 text-base text-[var(--text-secondary)]">
            Туристический портал Камчатки. Оставьте заявку, мы свяжемся и обсудим подключение.
          </p>
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-2">Для кого</h2>
          <div className="flex flex-wrap gap-2">
            {WHO.map(w => (
              <span key={w} className="px-3 py-1 rounded-full text-sm border border-[var(--border)] bg-white">{w}</span>
            ))}
          </div>
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-2">Что вы получаете</h2>
          <ul className="space-y-3">
            {GETS.map(g => (
              <li key={g} className="flex items-start gap-3">
                <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5" style={{ background: 'var(--success)' }}>
                  <Check className="w-3 h-3 text-white" />
                </span>
                <span className="text-sm text-[var(--text-secondary)]">{g}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="ds-card p-5 sm:p-8 bg-white">
        {state === 'done' ? (
          <div className="text-center space-y-3 py-8">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto" style={{ background: 'var(--success)' }}>
              <Check className="w-7 h-7 text-white" />
            </div>
            <h2 className="text-xl font-bold">Заявка принята</h2>
            <p className="text-sm text-[var(--text-muted)]">Свяжемся с вами по указанному контакту.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <h2 className="text-xl font-bold">Заявка на подключение</h2>
            <div>
              <label className={LBL} htmlFor="pa-company">Название компании</label>
              <input id="pa-company" className={INP} required minLength={2} maxLength={200}
                value={form.company} onChange={e => set('company', e.target.value)} placeholder="Камчатская рыбалка" />
            </div>
            <div>
              <label className={LBL} htmlFor="pa-type">Вид деятельности</label>
              <select id="pa-type" className={INP} required value={form.business_type} onChange={e => set('business_type', e.target.value)}>
                <option value="" disabled>Выберите</option>
                {Object.entries(BUSINESS_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className={LBL} htmlFor="pa-name">Контактное лицо</label>
              <input id="pa-name" className={INP} required minLength={2} maxLength={120}
                value={form.contact_name} onChange={e => set('contact_name', e.target.value)} placeholder="Иван" />
            </div>
            <div>
              <label className={LBL} htmlFor="pa-contact">Телефон, MAX или Telegram</label>
              <input id="pa-contact" className={INP} required minLength={5} maxLength={120} inputMode="tel"
                value={form.contact} onChange={e => set('contact', e.target.value)} placeholder="+7 914 … или @username" />
            </div>
            <div>
              <label className={LBL} htmlFor="pa-wants">Что хотите подключить</label>
              <textarea id="pa-wants" className={INP} rows={3} maxLength={1000}
                value={form.wants} onChange={e => set('wants', e.target.value)} placeholder="Туры, машины, жильё, трансфер…" />
            </div>
            {/* Ловушка для ботов: человек это поле не видит. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
              <label htmlFor="pa-website">Сайт</label>
              <input id="pa-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={e => set('website', e.target.value)} />
            </div>
            <label className="flex items-start gap-3 text-sm text-[var(--text-secondary)]">
              <input type="checkbox" className="mt-1 w-4 h-4" checked={form.pd_consent} onChange={e => set('pd_consent', e.target.checked)} required />
              <span>
                {PD_CONSENT_PARTNER_APPLY_TEXT}.{' '}
                <Link href={PD_CONSENT_POLICY_URL} className="underline" style={{ color: 'var(--accent)' }} target="_blank">Политика конфиденциальности</Link>
              </span>
            </label>
            {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
            <button type="submit" disabled={state === 'sending'}
              className="w-full py-3 rounded-md text-white font-semibold text-base disabled:opacity-60"
              style={{ background: 'var(--accent)' }}>
              {state === 'sending' ? 'Отправляем…' : 'Отправить заявку'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
