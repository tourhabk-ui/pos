'use client';

import { useCallback, useEffect, useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { User, Save, Loader2, Languages, Award, Mountain, AlertTriangle, Check, Clock, ShieldCheck, Send } from 'lucide-react';
import { profileStatusView } from '@/lib/operator/profile-status';
import GuideCertificationsBlock from './_GuideCertificationsBlock';

/**
 * Профиль гида — живой экран.
 *
 * До аудита бизнес-процессов 25.07 здесь стоял мок: setTimeout подставлял
 * «Ивана Петрова» с guide@example.com, а кнопка «Сохранить» крутила спиннер и
 * ничего не отправляла. При этом GET/PUT /api/guide/profile существовали,
 * были под requireRole(['guide','admin']) и писали в users + partners.
 * Экран приведён к этому контракту.
 *
 * Пакет A (25.09): «О себе» пишется в partners.description (колонки bio нет —
 * сохранение падало всегда); очищенный телефон уходит пустой строкой и
 * стирается, а не остаётся старым; опыт 0 лет — допустимое значение; имя на
 * витрине применяется и тогда, когда оно не менялось с загрузки. Не загрузилось
 * — формы нет вовсе: сохранить пустые поля поверх настоящих было бы хуже ошибки.
 * Статус проверки платформой виден и отсюда подаётся заявка: на публичной
 * витрине /guides только одобренные гиды.
 */

/** Специализации в API — фиксированный перечень (Zod-enum в роуте). */
const SPECIALIZATIONS: Array<{ value: string; label: string }> = [
  { value: 'volcanoes',   label: 'Вулканы' },
  { value: 'hiking',      label: 'Треккинг' },
  { value: 'wildlife',    label: 'Дикая природа' },
  { value: 'fishing',     label: 'Рыбалка' },
  { value: 'extreme',     label: 'Экстрим' },
  { value: 'rafting',     label: 'Сплавы' },
  { value: 'skiing',      label: 'Лыжи и снегоходы' },
  { value: 'photography', label: 'Фототуры' },
  { value: 'history',     label: 'История' },
  { value: 'cultural',    label: 'Культура' },
];

interface ProfileResponse {
  user: { id: string; email: string; name: string | null };
  partner: {
    name: string;
    description: string | null;
    languages: string[];
    specializations: string[];
    contact: Record<string, unknown> | null;
    experienceYears: number | null;
    profileStatus: string;
    profileReviewComment: string | null;
  } | null;
}

const INPUT =
  'w-full min-h-[44px] px-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)] transition-colors';

export default function GuideProfileClient() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [loaded, setLoaded] = useState(false);
  const [hasPartner, setHasPartner] = useState(false);
  const [name, setName] = useState('');
  const [partnerName, setPartnerName] = useState('');
  const [email, setEmail] = useState('');
  const [bio, setBio] = useState('');
  const [experience, setExperience] = useState('');
  const [status, setStatus] = useState<string>('none');
  const [reviewComment, setReviewComment] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [phone, setPhone] = useState('');
  const [languages, setLanguages] = useState('');
  const [specializations, setSpecializations] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/guide/profile');
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || 'Не удалось загрузить профиль');
        return;
      }
      const data = json.data as ProfileResponse;
      const p = data.partner;
      const contact = (p?.contact ?? {}) as Record<string, unknown>;
      setHasPartner(p !== null);
      setName(data.user.name ?? '');
      setEmail(data.user.email ?? '');
      setPartnerName(p?.name ?? '');
      setBio(p?.description ?? '');
      setExperience(p?.experienceYears == null ? '' : String(p.experienceYears));
      setPhone(typeof contact.phone === 'string' ? contact.phone : '');
      setLanguages((p?.languages ?? []).join(', '));
      setSpecializations(p?.specializations ?? []);
      setStatus(p?.profileStatus ?? 'none');
      setReviewComment(p?.profileReviewComment ?? null);
      setLoaded(true);
    } catch {
      setError('Сеть недоступна. Профиль не загружен.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function toggleSpec(value: string) {
    setSpecializations((prev) =>
      prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value],
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const exp = experience.trim();
    if (exp !== '' && !/^\d{1,2}$/.test(exp)) {
      setError('Опыт — целое число лет от 0 до 60 (или оставьте поле пустым)');
      return;
    }
    if (!name.trim() || !partnerName.trim()) {
      setError('ФИО и имя на витрине не могут быть пустыми');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/guide/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          partnerName: partnerName.trim(),
          description: bio,
          experienceYears: exp === '' ? null : Number(exp),
          languages: languages.split(',').map((l) => l.trim()).filter(Boolean),
          specializations,
          // Пустая строка — явная очистка телефона на сервере.
          phone: phone.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || 'Не удалось сохранить профиль');
        return;
      }
      setSaved(true);
      await load();
    } catch {
      setError('Сеть недоступна. Изменения не сохранены.');
    } finally {
      setSaving(false);
    }
  }

  async function submitForReview() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/guide/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submitForReview: true }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setError(json?.error || 'Заявку отправить не удалось');
        return;
      }
      await load();
    } catch {
      setError('Сеть недоступна. Заявка не отправлена.');
    } finally {
      setSubmitting(false);
    }
  }

  const statusView = profileStatusView(status);

  return (
    <Protected roles={['guide', 'admin']}>
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-6">
          <User className="w-6 h-6 text-[var(--accent)]" />
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Профиль гида</h1>
        </div>

        {loading && !loaded ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : !loaded ? (
          <div className="flex items-start gap-2 p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-sm text-[var(--text-primary)]">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] flex-shrink-0" />
            <span>{error ?? 'Профиль не загружен.'}</span>
          </div>
        ) : !hasPartner ? (
          <div className="p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-sm text-[var(--text-secondary)]">
            У этого аккаунта нет профиля гида — здесь нечего показывать.
          </div>
        ) : (
          <div className="space-y-5">
          <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5 flex items-start gap-3">
            <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10 shrink-0">
              {status === 'approved'
                ? <ShieldCheck className="w-[22px] h-[22px] text-[var(--success)]" strokeWidth={1.75} />
                : <Clock className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />}
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-semibold text-[var(--text-primary)]">
                Проверка платформой: <span className={statusView.color}>{statusView.label}</span>
              </p>
              <p className="text-[var(--text-secondary)] mt-1">
                {status === 'approved' && 'Ваш профиль виден туристам в реестре гидов.'}
                {status === 'pending' && 'Администратор проверяет профиль. До одобрения туристы его не видят.'}
                {(status === 'none' || status === 'rejected') && 'В реестре гидов на сайте показываются только профили, одобренные платформой.'}
              </p>
              {status === 'rejected' && reviewComment && (
                <p className="text-[var(--text-secondary)] mt-1">Причина отказа: {reviewComment}</p>
              )}
              {(status === 'none' || status === 'rejected') && (
                <button type="button" onClick={() => void submitForReview()} disabled={submitting}
                  className="mt-3 inline-flex items-center gap-2 min-h-[40px] px-4 rounded-lg bg-[var(--accent)] text-white text-sm font-medium disabled:opacity-50">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {status === 'rejected' ? 'Отправить на проверку снова' : 'Отправить на проверку'}
                </button>
              )}
            </div>
          </section>
          <form onSubmit={handleSave} className="space-y-5">
            {error && (
              <div className="flex items-start gap-2 p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-sm text-[var(--text-primary)]">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {saved && !error && (
              <div className="flex items-center gap-2 p-4 rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/10 text-sm text-[var(--text-primary)]">
                <Check className="w-4 h-4 text-[var(--success)]" />
                Профиль сохранён
              </div>
            )}

            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 space-y-4">
              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] flex items-center gap-1.5 mb-1.5">
                  <User className="w-4 h-4" /> ФИО
                </span>
                <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
              </label>

              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] flex items-center gap-1.5 mb-1.5">
                  <User className="w-4 h-4" /> Имя на витрине гидов
                </span>
                <input value={partnerName} onChange={(e) => setPartnerName(e.target.value)} className={INPUT} />
              </label>

              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Опыт работы гидом, лет</span>
                <input value={experience} onChange={(e) => setExperience(e.target.value)} inputMode="numeric"
                  className={INPUT} placeholder="Например, 5" />
              </label>

              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] flex items-center gap-1.5 mb-1.5">
                  <Mountain className="w-4 h-4" /> О себе
                </span>
                <textarea value={bio} onChange={(e) => setBio(e.target.value)} className={`${INPUT} min-h-[80px] py-3`} />
              </label>

              <div className="block">
                <span className="text-sm text-[var(--text-secondary)] flex items-center gap-1.5 mb-1.5">
                  <Award className="w-4 h-4" /> Специализации
                </span>
                <div className="flex flex-wrap gap-2">
                  {SPECIALIZATIONS.map((s) => {
                    const active = specializations.includes(s.value);
                    return (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => toggleSpec(s.value)}
                        className={`min-h-[36px] px-3 rounded-lg border text-sm transition-colors ${
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]'
                            : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                        }`}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] flex items-center gap-1.5 mb-1.5">
                  <Languages className="w-4 h-4" /> Языки
                </span>
                <input
                  value={languages}
                  onChange={(e) => setLanguages(e.target.value)}
                  className={INPUT}
                  placeholder="Русский, English"
                />
              </label>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Телефон</span>
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} className={INPUT} placeholder="+7 ..." />
                </label>
                <label className="block">
                  <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Email</span>
                  <input value={email} readOnly disabled className={`${INPUT} opacity-60 cursor-not-allowed`} />
                  <span className="text-xs text-[var(--text-muted)] mt-1 block">
                    Меняется через поддержку — это логин аккаунта
                  </span>
                </label>
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="min-h-[44px] px-6 py-3 bg-[var(--accent)] hover:opacity-90 text-white rounded-lg font-medium inline-flex items-center gap-2 disabled:opacity-50 transition-all duration-200"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Сохранить
            </button>
          </form>
          <GuideCertificationsBlock />
          </div>
        )}
      </div>
    </Protected>
  );
}
