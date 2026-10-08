'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Map as MapIcon, Users } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import {
  GROUP_INTEREST_KEYS, FITNESS_LABEL, BUDGET_LABEL, FITNESS_ORDER, BUDGET_ORDER,
  type GroupBudget, type GroupProfile,
} from '@/lib/planner/group-merge';
import { ACTIVITY_NAMES, type FitnessLevel } from '@/lib/planner/constants';

/** Сводка группы — то же, что отдаёт GET /api/trip-groups/[id]. */
export interface GroupSummaryView {
  id: string;
  arrivalDate: string;
  departureDate: string;
  expiresAt: string;
  members: number;
  maxMembers: number;
  profile: GroupProfile | null;
}

const ru = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });

/**
 * Страница группы (#2226). Сводка — только агрегат: чьи пожелания какие, не
 * видно никому, в том числе организатору. Своё участник отмечает флагами без
 * диагнозов и с согласием на обработку данных (решение владельца 08.10).
 */
export function TripGroupClient({ summary }: { summary: GroupSummaryView }) {
  const router = useRouter();
  const [interests, setInterests] = useState<string[]>([]);
  const [fitness, setFitness] = useState<FitnessLevel>('moderate');
  const [noHardClimbs, setNoHardClimbs] = useState(false);
  const [seasickness, setSeasickness] = useState(false);
  const [limitedMobility, setLimitedMobility] = useState(false);
  const [child, setChild] = useState('');
  const [budget, setBudget] = useState<GroupBudget>('comfort');
  const [pdConsent, setPdConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<'wish' | 'plan' | null>(null);
  const [copied, setCopied] = useState(false);

  const p = summary.profile;
  const full = summary.members >= summary.maxMembers;

  const toggle = (k: string) => setInterests((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[trip-group] ссылка не скопирована', err);
      setError('Не удалось скопировать — скопируйте адрес страницы вручную.');
    }
  };

  const sendWishes = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (interests.length === 0) { setError('Отметьте хотя бы одно занятие.'); return; }
    setBusy('wish');
    try {
      const res = await fetch(`/api/trip-groups/${summary.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interests, fitness, no_hard_climbs: noHardClimbs, seasickness, limited_mobility: limitedMobility,
          youngest_child: child.trim() === '' ? null : Number(child), budget, pd_consent: pdConsent,
        }),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!res.ok || !json?.success) { setError(json?.error ?? 'Не удалось сохранить пожелания.'); return; }
      setSent(true);
      router.refresh();
    } catch (err) {
      console.error('[trip-group] пожелания не отправлены', err);
      setError('Не удалось связаться с сервером. Проверьте связь и попробуйте ещё раз.');
    } finally {
      setBusy(null);
    }
  };

  const buildPlan = async () => {
    setError(null);
    setBusy('plan');
    try {
      const res = await fetch(`/api/trip-groups/${summary.id}/plan`, { method: 'POST' });
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string; data?: { url: string } } | null;
      if (!res.ok || !json?.success || !json.data) { setError(json?.error ?? 'План не собрался.'); return; }
      router.push(json.data.url);
    } catch (err) {
      console.error('[trip-group] план не собран', err);
      setError('Не удалось связаться с сервером. Проверьте связь и попробуйте ещё раз.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="ds-page min-h-screen px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-2">
          <p className="ds-label flex items-center gap-2"><Users className="w-4 h-4" /> Поездка группой</p>
          <h1 className="font-playfair text-4xl font-bold text-[var(--text-primary)]">
            {ru(summary.arrivalDate)} — {ru(summary.departureDate)}
          </h1>
          <p className="text-[var(--text-secondary)]">
            Участников: {summary.members} из {summary.maxMembers}. Группа хранится до {ru(summary.expiresAt)}.
          </p>
          <button type="button" onClick={copyLink} className="inline-flex items-center gap-2 min-h-[44px] text-sm text-[var(--ocean)] hover:underline">
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Ссылка скопирована' : 'Скопировать ссылку для попутчиков'}
          </button>
        </header>

        <section className="ds-card p-5 space-y-3" aria-labelledby="group-summary">
          <h2 id="group-summary" className="ds-h2">Что получилось у группы</h2>
          {!p ? (
            <p className="text-[var(--text-secondary)]">Пожеланий ещё нет. Отметьте свои ниже и отправьте ссылку попутчикам.</p>
          ) : (
            <>
              <p className="text-[var(--text-primary)]">
                Занятия: {p.votes.map((v) => `${ACTIVITY_NAMES[v.interest] ?? v.interest} (${v.votes})`).join(', ') || 'не выбраны'}.
              </p>
              <p className="text-[var(--text-secondary)]">
                Темп — {FITNESS_LABEL[p.fitness]}, жильё — {BUDGET_LABEL[p.budget]}
                {p.children.length > 0 ? `, младшему ребёнку ${p.children[0]}` : ''}.
              </p>
              {p.conflicts.length > 0 && (
                <ul className="space-y-1 text-sm text-[var(--text-secondary)] list-disc pl-5">
                  {p.conflicts.map((c) => <li key={c}>{c}</li>)}
                </ul>
              )}
              <button type="button" onClick={buildPlan} disabled={busy !== null || p.interests.length === 0} className="ds-btn ds-btn-primary inline-flex items-center gap-2">
                <MapIcon className="w-4 h-4" /> {busy === 'plan' ? 'Собираю…' : 'Собрать план группы'}
              </button>
            </>
          )}
        </section>

        {sent ? (
          <section className="ds-card p-5" role="status">
            <p className="text-[var(--text-primary)]">Ваши пожелания учтены. Сводка выше обновлена.</p>
          </section>
        ) : full ? (
          <section className="ds-card p-5">
            <p className="text-[var(--text-secondary)]">В группе уже {summary.maxMembers} участников — новые пожелания не принимаются.</p>
          </section>
        ) : (
          <form onSubmit={sendWishes} className="ds-card p-5 space-y-5" aria-labelledby="my-wishes">
            <h2 id="my-wishes" className="ds-h2">Мои пожелания</h2>

            <fieldset className="space-y-2">
              <legend className="ds-label">Что хочется</legend>
              <div className="flex flex-wrap gap-2">
                {GROUP_INTEREST_KEYS.map((k) => (
                  <label key={k} className={`inline-flex items-center gap-2 min-h-[44px] px-3 rounded-lg border cursor-pointer text-sm transition-colors duration-200 ${interests.includes(k) ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-primary)]'}`}>
                    <input type="checkbox" className="sr-only" checked={interests.includes(k)} onChange={() => toggle(k)} />
                    {ACTIVITY_NAMES[k] ?? k}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="ds-label">Подготовка</legend>
              <div className="flex flex-wrap gap-4">
                {FITNESS_ORDER.map((f) => (
                  <label key={f} className="inline-flex items-center gap-2 min-h-[44px] text-sm text-[var(--text-primary)]">
                    <input type="radio" name="fitness" checked={fitness === f} onChange={() => setFitness(f)} className="accent-[var(--accent)]" />
                    {FITNESS_LABEL[f]}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="space-y-1">
              <legend className="ds-label">Что не подходит — без диагнозов, только отметка</legend>
              <label className="flex items-center gap-2 min-h-[44px] text-sm text-[var(--text-primary)]">
                <input type="checkbox" checked={noHardClimbs} onChange={(e) => setNoHardClimbs(e.target.checked)} className="accent-[var(--accent)]" />
                Тяжёлые подъёмы не подходят
              </label>
              <label className="flex items-center gap-2 min-h-[44px] text-sm text-[var(--text-primary)]">
                <input type="checkbox" checked={seasickness} onChange={(e) => setSeasickness(e.target.checked)} className="accent-[var(--accent)]" />
                Укачивает в море
              </label>
              <label className="flex items-center gap-2 min-h-[44px] text-sm text-[var(--text-primary)]">
                <input type="checkbox" checked={limitedMobility} onChange={(e) => setLimitedMobility(e.target.checked)} className="accent-[var(--accent)]" />
                Ограничена подвижность
              </label>
            </fieldset>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="ds-label">Возраст младшего ребёнка</span>
                <input type="number" inputMode="numeric" min={0} max={17} placeholder="нет детей" value={child} onChange={(e) => setChild(e.target.value)} className="ds-input w-full" />
              </label>
              <label className="block">
                <span className="ds-label">Бюджет на жильё</span>
                <select value={budget} onChange={(e) => setBudget(e.target.value as GroupBudget)} className="ds-input w-full">
                  {BUDGET_ORDER.map((b) => <option key={b} value={b}>{BUDGET_LABEL[b]}</option>)}
                </select>
              </label>
            </div>

            <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="trip-group-consent" />
            {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
            <button type="submit" disabled={busy !== null || !pdConsent} className="ds-btn ds-btn-primary w-full">
              {busy === 'wish' ? 'Отправляю…' : 'Добавить мои пожелания'}
            </button>
          </form>
        )}
        {error && (sent || full) && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      </div>
    </main>
  );
}
