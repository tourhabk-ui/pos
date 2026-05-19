'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { MapPin, Calendar, Users, Phone, Shield, AlertTriangle, Download, ArrowLeft, Trash2, CheckCircle, Loader2, Copy, Check } from 'lucide-react';

type Step = 1 | 2 | 3 | 4;

interface GroupMember {
  name: string;
  phone: string;
  birth_year: string;
}

const inputCls = `w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)]
  text-[var(--text-primary)] text-sm placeholder:text-[var(--text-muted)]
  focus:border-[var(--accent)] focus:outline-none transition-colors`;

const inputSmCls = `w-full px-3 py-2 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)]
  text-[var(--text-primary)] text-sm placeholder:text-[var(--text-muted)]
  focus:border-[var(--accent)] focus:outline-none`;

export default function RegisterRoutePage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [registrationId, setRegistrationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedReturn, setCopiedReturn] = useState(false);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!submitted || !registrationId || !qrCanvasRef.current) return;
    const returnUrl = `${window.location.origin}/return?id=${registrationId}`;
    QRCode.toCanvas(qrCanvasRef.current, returnUrl, { width: 160, margin: 1 }).catch(() => undefined);
  }, [submitted, registrationId]);

  const [routeName, setRouteName] = useState('');
  const [routeDescription, setRouteDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [region, setRegion] = useState('Камчатский край');

  const [groupSize, setGroupSize] = useState(1);
  const [members, setMembers] = useState<GroupMember[]>([{ name: '', phone: '', birth_year: '' }]);

  const [leaderName, setLeaderName] = useState('');
  const [leaderPhone, setLeaderPhone] = useState('');
  const [leaderEmail, setLeaderEmail] = useState('');
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [emergencyRelation, setEmergencyRelation] = useState('');
  const [emergencyTelegram, setEmergencyTelegram] = useState('');
  const [emergencyEmail, setEmergencyEmail] = useState('');
  const [contactConsent, setContactConsent] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const canNext1 = routeName.trim() && startDate && endDate && new Date(endDate) >= new Date(startDate);
  const canNext2 = groupSize >= 1 && groupSize <= 30;
  const canNext3 = leaderName.trim() && leaderPhone.trim() && emergencyName.trim() && emergencyPhone.trim();
  const canSubmit = canNext1 && canNext2 && canNext3 && accepted && contactConsent;

  const addMember = () => {
    if (members.length < groupSize) {
      setMembers([...members, { name: '', phone: '', birth_year: '' }]);
    }
  };

  const removeMember = (idx: number) => {
    setMembers(members.filter((_, i) => i !== idx));
  };

  const updateMember = (idx: number, field: keyof GroupMember, value: string) => {
    const updated = [...members];
    updated[idx] = { ...updated[idx], [field]: value };
    setMembers(updated);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const payload = {
        route_name: routeName.trim(),
        route_description: routeDescription.trim() || undefined,
        start_date: startDate,
        end_date: endDate,
        region,
        group_size: groupSize,
        group_members: members.filter(m => m.name.trim()).map(m => ({
          name: m.name.trim(),
          phone: m.phone.trim() || undefined,
          birth_year: m.birth_year ? parseInt(m.birth_year) : undefined,
        })),
        leader_name: leaderName.trim(),
        leader_phone: leaderPhone.trim(),
        leader_email: leaderEmail.trim() || undefined,
        emergency_contact_name: emergencyName.trim(),
        emergency_contact_phone: emergencyPhone.trim(),
        emergency_contact_relation: emergencyRelation.trim() || undefined,
        emergency_contact_telegram_chat_id: emergencyTelegram.trim() || undefined,
        emergency_contact_email: emergencyEmail.trim() || undefined,
        emergency_contact_consent: contactConsent,
        accepted_disclaimer: true as const,
      };

      const res = await fetch('/api/safety/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || 'Ошибка сохранения');
        setSubmitting(false);
        return;
      }

      setRegistrationId(json.registration_id);

      const pdfRes = await fetch('/api/safety/register?pdf=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (pdfRes.ok) {
        const blob = await pdfRes.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tourhab-registration-${json.registration_id.slice(0, 8)}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      }

      setSubmitted(true);
    } catch {
      setError('Ошибка сети. Проверьте подключение.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--success)]/10 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-[var(--success)]" />
          </div>
          <h1 className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-2">Маршрут зарегистрирован</h1>
          <p className="text-[var(--text-secondary)] mb-6 text-sm">
            PDF-заявка скачана. Подайте её в МЧС одним из способов:
          </p>

          <div className="space-y-3 mb-6 text-left">
            <div className="ds-card p-4 space-y-1">
              <p className="font-semibold text-sm text-[var(--text-primary)]">Через Госуслуги</p>
              <p className="text-xs text-[var(--text-muted)]">Подайте электронное заявление на gosuslugi.ru</p>
              <a href="https://www.gosuslugi.ru" target="_blank" rel="noopener noreferrer"
                 className="text-[var(--accent)] text-xs font-medium mt-1 inline-block hover:underline">
                Открыть Госуслуги →
              </a>
            </div>
            <div className="ds-card p-4">
              <p className="font-semibold text-sm text-[var(--text-primary)] mb-1">По телефону МЧС</p>
              <p className="text-xs text-[var(--text-muted)]">+7 (4152) 23-53-62 — Главное управление МЧС по Камчатскому краю</p>
            </div>
            <div className="ds-card p-4">
              <p className="font-semibold text-sm text-[var(--text-primary)] mb-1">Лично</p>
              <p className="text-xs text-[var(--text-muted)]">г. Петропавловск-Камчатский, ул. Ленинская, 28</p>
            </div>
          </div>

          {/* Return notification block */}
          {registrationId && (
            <div className="ds-card p-4 mb-6 text-left">
              <p className="font-semibold text-sm text-[var(--text-primary)] mb-1">Когда вернётесь — отметьтесь</p>
              <p className="text-xs text-[var(--text-muted)] mb-3">
                Сохраните ссылку или QR-код — после возвращения нажмите, чтобы закрыть маршрут и остановить эскалацию.
              </p>
              <div className="flex items-start gap-4">
                <canvas ref={qrCanvasRef} className="rounded-lg shrink-0" style={{ width: 96, height: 96 }} />
                <div className="flex-1 min-w-0 space-y-2">
                  <p className="text-xs text-[var(--text-muted)] break-all font-mono">
                    /return?id={registrationId.slice(0, 8)}…
                  </p>
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(`${window.location.origin}/return?id=${registrationId}`).then(() => {
                        setCopiedReturn(true);
                        setTimeout(() => setCopiedReturn(false), 2000);
                      });
                    }}
                    className="ds-btn ds-btn-secondary text-xs flex items-center gap-1.5 w-full justify-center"
                  >
                    {copiedReturn ? <><Check className="w-3.5 h-3.5 text-[var(--success)]" /> Скопировано</> : <><Copy className="w-3.5 h-3.5" /> Копировать ссылку</>}
                  </button>
                </div>
              </div>
            </div>
          )}

          <button onClick={() => router.push('/map')} className="ds-btn ds-btn-primary w-full">
            Вернуться к карте
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--bg-primary)]">
      {/* Шапка */}
      <div className="sticky top-0 z-50 bg-[var(--bg-card)] border-b border-[var(--border)]">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => step > 1 ? setStep((step - 1) as Step) : router.back()}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="font-semibold text-sm text-[var(--text-primary)]">Регистрация маршрута</h1>
            <p className="text-[10px] text-[var(--text-muted)]">Шаг {step} из 4</p>
          </div>
          <div className="flex gap-1">
            {[1, 2, 3, 4].map(s => (
              <div key={s} className={`w-6 h-1 rounded-full transition-colors ${
                s <= step ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
              }`} />
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6">
        {/* Шаг 1: Маршрут */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="font-playfair text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
              <MapPin className="w-5 h-5 text-[var(--accent)]" />
              Маршрут
            </h2>

            <div>
              <label className="ds-label">Название маршрута *</label>
              <input
                type="text"
                value={routeName}
                onChange={e => setRouteName(e.target.value)}
                placeholder="Авачинский перевал"
                className={inputCls}
              />
            </div>

            <div>
              <label className="ds-label">Описание (необязательно)</label>
              <textarea
                value={routeDescription}
                onChange={e => setRouteDescription(e.target.value)}
                placeholder="Пиначево → Таловский кордон → Авачинский перевал"
                rows={3}
                className={`${inputCls} resize-none`}
              />
            </div>

            <div>
              <label className="ds-label">Регион</label>
              <input type="text" value={region} onChange={e => setRegion(e.target.value)} className={inputCls} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="ds-label">Дата выхода *</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="ds-label">Дата возврата *</label>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} min={startDate} className={inputCls} />
              </div>
            </div>

            <button onClick={() => setStep(2)} disabled={!canNext1} className="ds-btn ds-btn-primary w-full disabled:opacity-30">
              Далее
            </button>
          </div>
        )}

        {/* Шаг 2: Группа */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="font-playfair text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
              <Users className="w-5 h-5 text-[var(--accent)]" />
              Группа
            </h2>

            <div>
              <label className="ds-label">Количество человек (1-30) *</label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    const newSize = Math.max(1, groupSize - 1);
                    setGroupSize(newSize);
                    if (members.length > newSize) setMembers(members.slice(0, newSize));
                  }}
                  className="w-12 h-12 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-xl font-bold
                    text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
                >
                  −
                </button>
                <span className="text-3xl font-bold flex-1 text-center text-[var(--text-primary)]">{groupSize}</span>
                <button
                  onClick={() => {
                    const newSize = Math.min(30, groupSize + 1);
                    setGroupSize(newSize);
                    if (members.length < newSize) addMember();
                  }}
                  className="w-12 h-12 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-xl font-bold
                    text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
                >
                  +
                </button>
              </div>
            </div>

            <p className="text-xs text-[var(--text-muted)]">Участники (необязательно, но полезно для МЧС)</p>
            {members.map((m, idx) => (
              <div key={idx} className="ds-card p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-muted)] w-5">#{idx + 1}</span>
                  {members.length > 1 && (
                    <button onClick={() => removeMember(idx)} className="ml-auto p-1 text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <input type="text" value={m.name} onChange={e => updateMember(idx, 'name', e.target.value)} placeholder="ФИО" className={inputSmCls} />
                <div className="grid grid-cols-2 gap-2">
                  <input type="tel" value={m.phone} onChange={e => updateMember(idx, 'phone', e.target.value)} placeholder="Телефон" className={inputSmCls} />
                  <input type="number" value={m.birth_year} onChange={e => updateMember(idx, 'birth_year', e.target.value)} placeholder="Год рождения" className={inputSmCls} />
                </div>
              </div>
            ))}

            <div className="flex gap-3">
              <button onClick={() => setStep(1)} className="ds-btn ds-btn-secondary flex-1">Назад</button>
              <button onClick={() => setStep(3)} className="ds-btn ds-btn-primary flex-[2]">Далее</button>
            </div>
          </div>
        )}

        {/* Шаг 3: Контакты */}
        {step === 3 && (
          <div className="space-y-4">
            <h2 className="font-playfair text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
              <Phone className="w-5 h-5 text-[var(--accent)]" />
              Контакты
            </h2>

            <div className="ds-card p-4 space-y-3">
              <p className="text-xs text-[var(--accent)] font-semibold uppercase tracking-wider">Руководитель группы</p>
              <input type="text" value={leaderName} onChange={e => setLeaderName(e.target.value)} placeholder="ФИО *" className={inputCls} />
              <div className="grid grid-cols-2 gap-2">
                <input type="tel" value={leaderPhone} onChange={e => setLeaderPhone(e.target.value)} placeholder="Телефон *" className={inputCls} />
                <input type="email" value={leaderEmail} onChange={e => setLeaderEmail(e.target.value)} placeholder="Email" className={inputCls} />
              </div>
            </div>

            <div className="ds-card p-4 space-y-3">
              <p className="text-xs text-[var(--danger)] font-semibold uppercase tracking-wider">
                Экстренный контакт <span className="text-[var(--text-muted)] normal-case font-normal">(получит уведомление если не вернулись)</span>
              </p>
              <input type="text" value={emergencyName} onChange={e => setEmergencyName(e.target.value)} placeholder="ФИО *" className={inputCls} />
              <div className="grid grid-cols-2 gap-2">
                <input type="tel" value={emergencyPhone} onChange={e => setEmergencyPhone(e.target.value)} placeholder="Телефон *" className={inputCls} />
                <input type="text" value={emergencyRelation} onChange={e => setEmergencyRelation(e.target.value)} placeholder="Кем приходится" className={inputCls} />
              </div>
              <input type="text" value={emergencyTelegram} onChange={e => setEmergencyTelegram(e.target.value)} placeholder="Telegram chat_id (необязательно)" className={inputCls} />
              <p className="text-[10px] text-[var(--text-muted)]">Для Telegram-уведомлений. Можно узнать через @userinfobot</p>
              <input type="email" value={emergencyEmail} onChange={e => setEmergencyEmail(e.target.value)} placeholder="Email (необязательно)" className={inputCls} />
              <label className="flex items-start gap-3 cursor-pointer mt-2">
                <input type="checkbox" checked={contactConsent} onChange={e => setContactConsent(e.target.checked)} className="mt-1 w-4 h-4 rounded accent-[var(--accent)]" />
                <span className="text-xs text-[var(--text-secondary)]">
                  Контакт <strong>{emergencyName || '___'}</strong> согласен получать уведомления
                  от TourHab о статусе маршрута (Telegram / Email).
                </span>
              </label>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setStep(2)} className="ds-btn ds-btn-secondary flex-1">Назад</button>
              <button onClick={() => setStep(4)} disabled={!canNext3} className="ds-btn ds-btn-primary flex-[2] disabled:opacity-30">Далее</button>
            </div>
          </div>
        )}

        {/* Шаг 4: Подтверждение */}
        {step === 4 && (
          <div className="space-y-4">
            <h2 className="font-playfair text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
              <Shield className="w-5 h-5 text-[var(--accent)]" />
              Подтверждение
            </h2>

            <div className="ds-card p-4 space-y-2 text-sm">
              <p><span className="text-[var(--text-muted)]">Маршрут:</span> <span className="text-[var(--text-primary)]">{routeName}</span></p>
              <p><span className="text-[var(--text-muted)]">Даты:</span> <span className="text-[var(--text-primary)]">{startDate} — {endDate}</span></p>
              <p><span className="text-[var(--text-muted)]">Группа:</span> <span className="text-[var(--text-primary)]">{groupSize} чел.</span></p>
              <p><span className="text-[var(--text-muted)]">Руководитель:</span> <span className="text-[var(--text-primary)]">{leaderName}</span></p>
              <p><span className="text-[var(--text-muted)]">Экстренный контакт:</span> <span className="text-[var(--text-primary)]">{emergencyName} ({emergencyPhone})</span></p>
            </div>

            <div className="p-4 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30 space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-[var(--warning)] flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-[var(--warning)] mb-1">Важно</p>
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                    TourHub помогает <strong>подготовить заявку</strong> по форме МЧС.
                    Данная заявка <strong>не является подтверждением</strong> регистрации в МЧС.
                    Для официальной регистрации подайте заявление через портал Госуслуг
                    или лично в Главное управление МЧС России по Камчатскому краю.
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mt-2">
                    TourHab не гарантирует получение уведомления экстренным контактом
                    и не несёт ответственности за реакцию третьих лиц.
                  </p>
                </div>
              </div>

              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-1 w-4 h-4 rounded accent-[var(--accent)]" />
                <span className="text-xs text-[var(--text-secondary)]">
                  Я понимаю что это <strong>не официальная регистрация</strong> и
                  TourHab <strong>не является службой спасения</strong>.
                  Я самостоятельно подам заявку в МЧС.
                </span>
              </label>
            </div>

            {error && (
              <p className="text-sm text-[var(--danger)] text-center">{error}</p>
            )}

            <div className="flex gap-3">
              <button onClick={() => setStep(3)} className="ds-btn ds-btn-secondary flex-1">Назад</button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || submitting}
                className="ds-btn ds-btn-primary flex-[2] disabled:opacity-30 flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" />Сохраняю...</>
                ) : (
                  <><Download className="w-4 h-4" />Создать и скачать PDF</>
                )}
              </button>
            </div>
          </div>
        )}

        <div className="h-8" />
      </div>
    </div>
  );
}
