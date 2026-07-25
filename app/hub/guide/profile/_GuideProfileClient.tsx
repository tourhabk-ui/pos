'use client';

import { useCallback, useEffect, useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { User, Save, Loader2, Languages, Award, Mountain, AlertTriangle, Check } from 'lucide-react';

/**
 * Профиль гида — живой экран.
 *
 * До аудита бизнес-процессов 25.07 здесь стоял мок: setTimeout подставлял
 * «Ивана Петрова» с guide@example.com, а кнопка «Сохранить» крутила спиннер и
 * ничего не отправляла. При этом GET/PUT /api/guide/profile существовали,
 * были под requireRole(['guide','admin']) и писали в users + partners.
 * Экран приведён к этому контракту.
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
    bio?: string | null;
    languages?: string[] | null;
    specializations?: string[] | null;
    contact?: Record<string, unknown> | null;
  } | null;
}

const INPUT =
  'w-full min-h-[44px] px-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)] transition-colors';

export default function GuideProfileClient() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [bio, setBio] = useState('');
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
      const contact = (data.partner?.contact ?? {}) as Record<string, unknown>;
      setName(data.user.name ?? '');
      setEmail(data.user.email ?? '');
      setBio(data.partner?.bio ?? '');
      setPhone(typeof contact.phone === 'string' ? contact.phone : '');
      setLanguages((data.partner?.languages ?? []).join(', '));
      setSpecializations(data.partner?.specializations ?? []);
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
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/guide/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || undefined,
          bio,
          languages: languages.split(',').map((l) => l.trim()).filter(Boolean),
          specializations,
          contact: phone.trim() ? { phone: phone.trim() } : undefined,
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

  return (
    <Protected roles={['guide', 'admin']}>
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-6">
          <User className="w-6 h-6 text-[var(--accent)]" />
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Профиль гида</h1>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : (
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
        )}
      </div>
    </Protected>
  );
}
