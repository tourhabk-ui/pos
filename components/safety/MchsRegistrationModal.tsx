'use client';

import { useState, useCallback } from 'react';
import {
  X, ChevronRight, ChevronLeft, ShieldAlert,
  CheckCircle, Download, Loader2, Plus, Trash2,
} from 'lucide-react';

interface RouteContext {
  routeName: string;
  mchsPhone: string | null;
}

interface Member { name: string; phone: string; birth_year: string }

interface FormState {
  // Шаг 1 — Маршрут
  route_name: string;
  start_date: string;
  end_date: string;
  region: string;
  // Шаг 2 — Группа
  group_size: string;
  members: Member[];
  // Шаг 3 — Руководитель
  leader_name: string;
  leader_phone: string;
  leader_email: string;
  // Шаг 4 — Экстренный контакт
  ec_name: string;
  ec_phone: string;
  ec_relation: string;
  ec_consent: boolean;
  accepted_disclaimer: boolean;
}

const STEPS = ['Маршрут', 'Группа', 'Руководитель', 'Контакт'];

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoPlus = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 5 }}>
      {children}{required && <span style={{ color: 'var(--danger)', marginLeft: 3 }}>*</span>}
    </label>
  );
}

function Input({ value, onChange, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { value: string; onChange: (v: string) => void }) {
  return (
    <input
      {...rest}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', padding: '9px 12px', borderRadius: 8,
        border: '1px solid var(--border)', background: 'var(--bg-primary)',
        color: 'var(--text-primary)', fontSize: 14, outline: 'none',
      }}
    />
  );
}

export function MchsRegistrationModal({ route, onClose }: { route: RouteContext; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [registrationId, setRegistrationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>({
    route_name: route.routeName,
    start_date: isoToday(),
    end_date: isoPlus(3),
    region: 'Камчатский край',
    group_size: '2',
    members: [],
    leader_name: '',
    leader_phone: '',
    leader_email: '',
    ec_name: '',
    ec_phone: '',
    ec_relation: '',
    ec_consent: false,
    accepted_disclaimer: false,
  });

  const set = useCallback((key: keyof FormState, val: unknown) => {
    setForm(prev => ({ ...prev, [key]: val }));
  }, []);

  const addMember = () => setForm(p => ({ ...p, members: [...p.members, { name: '', phone: '', birth_year: '' }] }));
  const removeMember = (i: number) => setForm(p => ({ ...p, members: p.members.filter((_, j) => j !== i) }));
  const setMember = (i: number, field: keyof Member, val: string) =>
    setForm(p => { const m = [...p.members]; m[i] = { ...m[i], [field]: val }; return { ...p, members: m }; });

  const canNext = () => {
    if (step === 0) return form.route_name.trim() && form.start_date && form.end_date;
    if (step === 1) return Number(form.group_size) >= 1;
    if (step === 2) return form.leader_name.trim() && form.leader_phone.trim().length >= 5;
    return true;
  };

  const submit = async () => {
    if (!form.ec_name.trim() || !form.ec_phone.trim()) {
      setError('Укажите экстренный контакт');
      return;
    }
    if (!form.accepted_disclaimer) {
      setError('Необходимо принять условия');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        route_name: form.route_name,
        start_date: form.start_date,
        end_date: form.end_date,
        region: form.region,
        group_size: Number(form.group_size),
        group_members: form.members
          .filter(m => m.name.trim())
          .map(m => ({
            name: m.name,
            phone: m.phone || undefined,
            birth_year: m.birth_year ? Number(m.birth_year) : undefined,
          })),
        leader_name: form.leader_name,
        leader_phone: form.leader_phone,
        leader_email: form.leader_email || undefined,
        emergency_contact_name: form.ec_name,
        emergency_contact_phone: form.ec_phone,
        emergency_contact_relation: form.ec_relation || undefined,
        emergency_contact_consent: form.ec_consent,
        accepted_disclaimer: true as const,
      };
      const res = await fetch('/api/safety/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Ошибка сервера');
      setRegistrationId(json.registration_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Неизвестная ошибка');
    } finally {
      setBusy(false);
    }
  };

  const downloadPdf = () => {
    if (!registrationId) return;
    window.open(`/api/safety/register/${registrationId}?pdf`, '_blank');
  };

  // Overlay
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 540,
          background: 'var(--bg-card)',
          borderRadius: '20px 20px 0 0',
          maxHeight: '90dvh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Шапка */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        }}>
          <ShieldAlert size={18} style={{ color: 'var(--danger)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Регистрация в МЧС
            </p>
            {!registrationId && (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Шаг {step + 1} из {STEPS.length} — {STEPS[step]}
              </p>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        {/* Прогресс */}
        {!registrationId && (
          <div style={{ display: 'flex', gap: 4, padding: '10px 20px 0', flexShrink: 0 }}>
            {STEPS.map((_, i) => (
              <div key={i} style={{
                flex: 1, height: 3, borderRadius: 2,
                background: i <= step ? 'var(--danger)' : 'var(--border)',
                transition: 'background 0.2s',
              }} />
            ))}
          </div>
        )}

        {/* Контент */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {registrationId ? (
            <SuccessView
              registrationId={registrationId}
              mchsPhone={route.mchsPhone}
              onDownload={downloadPdf}
              onClose={onClose}
            />
          ) : (
            <>
              {step === 0 && <StepRoute form={form} set={set} />}
              {step === 1 && <StepGroup form={form} set={set} addMember={addMember} removeMember={removeMember} setMember={setMember} />}
              {step === 2 && <StepLeader form={form} set={set} />}
              {step === 3 && <StepContact form={form} set={set} />}
              {error && (
                <p style={{ marginTop: 10, fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>{error}</p>
              )}
            </>
          )}
        </div>

        {/* Кнопки навигации */}
        {!registrationId && (
          <div style={{
            padding: '12px 20px 20px', borderTop: '1px solid var(--border)',
            display: 'flex', gap: 8, flexShrink: 0,
          }}>
            {step > 0 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="ds-btn ds-btn-secondary"
                style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <ChevronLeft size={15} /> Назад
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                onClick={() => canNext() && setStep(s => s + 1)}
                disabled={!canNext()}
                className="ds-btn ds-btn-primary"
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: canNext() ? 1 : 0.4 }}
              >
                Далее <ChevronRight size={15} />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={busy}
                className="ds-btn ds-btn-danger"
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                {busy ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <ShieldAlert size={15} />}
                {busy ? 'Отправляем...' : 'Зарегистрировать группу'}
              </button>
            )}
          </div>
        )}
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

function StepRoute({ form, set }: { form: FormState; set: (k: keyof FormState, v: unknown) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <Label required>Название маршрута</Label>
        <Input value={form.route_name} onChange={v => set('route_name', v)} placeholder="Восхождение на Авачинский" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <Label required>Дата начала</Label>
          <Input type="date" value={form.start_date} onChange={v => set('start_date', v)} />
        </div>
        <div>
          <Label required>Дата окончания</Label>
          <Input type="date" value={form.end_date} onChange={v => set('end_date', v)} min={form.start_date} />
        </div>
      </div>
      <div>
        <Label>Регион</Label>
        <Input value={form.region} onChange={v => set('region', v)} />
      </div>
    </div>
  );
}

function StepGroup({ form, set, addMember, removeMember, setMember }: {
  form: FormState;
  set: (k: keyof FormState, v: unknown) => void;
  addMember: () => void;
  removeMember: (i: number) => void;
  setMember: (i: number, f: keyof Member, v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <Label required>Количество участников</Label>
        <Input type="number" min="1" max="30" value={form.group_size} onChange={v => set('group_size', v)} />
      </div>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <Label>Состав группы (необязательно)</Label>
          <button onClick={addMember} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Plus size={12} /> Добавить
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {form.members.map((m, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 80px 32px', gap: 6, alignItems: 'center' }}>
              <input value={m.name} onChange={e => setMember(i, 'name', e.target.value)} placeholder="Имя" style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }} />
              <input value={m.phone} onChange={e => setMember(i, 'phone', e.target.value)} placeholder="Телефон" style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }} />
              <input value={m.birth_year} onChange={e => setMember(i, 'birth_year', e.target.value)} placeholder="Год" type="number" style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }} />
              <button onClick={() => removeMember(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: 4 }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepLeader({ form, set }: { form: FormState; set: (k: keyof FormState, v: unknown) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <Label required>ФИО руководителя</Label>
        <Input value={form.leader_name} onChange={v => set('leader_name', v)} placeholder="Иванов Иван Иванович" />
      </div>
      <div>
        <Label required>Телефон</Label>
        <Input type="tel" value={form.leader_phone} onChange={v => set('leader_phone', v)} placeholder="+7 900 000 0000" />
      </div>
      <div>
        <Label>Email (необязательно)</Label>
        <Input type="email" value={form.leader_email} onChange={v => set('leader_email', v)} placeholder="ivan@example.com" />
      </div>
    </div>
  );
}

function StepContact({ form, set }: { form: FormState; set: (k: keyof FormState, v: unknown) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
        Экстренный контакт получит уведомление, если группа не вернётся вовремя.
      </p>
      <div>
        <Label required>ФИО контакта</Label>
        <Input value={form.ec_name} onChange={v => set('ec_name', v)} placeholder="Иванова Мария Ивановна" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <Label required>Телефон</Label>
          <Input type="tel" value={form.ec_phone} onChange={v => set('ec_phone', v)} placeholder="+7 900 000 0000" />
        </div>
        <div>
          <Label>Кем приходится</Label>
          <Input value={form.ec_relation} onChange={v => set('ec_relation', v)} placeholder="Супруг(а), друг..." />
        </div>
      </div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        <input type="checkbox" checked={form.ec_consent} onChange={e => set('ec_consent', e.target.checked)} style={{ marginTop: 2, flexShrink: 0 }} />
        Контакт знает о маршруте и согласен получать уведомления в случае задержки
      </label>
      <div style={{ padding: '12px 14px', borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
          Регистрация на платформе не заменяет официальную регистрацию в МЧС.
          После сохранения скачайте PDF и подайте его в ГУ МЧС России по Камчатскому краю.
        </p>
      </div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        <input type="checkbox" checked={form.accepted_disclaimer} onChange={e => set('accepted_disclaimer', e.target.checked)} style={{ marginTop: 2, flexShrink: 0 }} />
        Понимаю, что эта форма — не официальная регистрация в МЧС, и обязуюсь подать официальное заявление
      </label>
    </div>
  );
}

function SuccessView({ registrationId, mchsPhone, onDownload, onClose }: {
  registrationId: string;
  mchsPhone: string | null;
  onDownload: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(registrationId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 8 }}>
      <div style={{ textAlign: 'center' }}>
        <CheckCircle size={40} style={{ color: 'var(--success)', margin: '8px auto' }} />
        <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', margin: '8px 0 4px' }}>Группа зарегистрирована</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
          Сохраните номер регистрации и скачайте PDF-заявку
        </p>
      </div>

      {/* ID регистрации */}
      <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-hover)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '0 0 2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ID регистрации</p>
          <p style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-primary)', margin: 0, wordBreak: 'break-all' }}>{registrationId}</p>
        </div>
        <button onClick={copy} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', color: copied ? 'var(--success)' : 'var(--text-secondary)', flexShrink: 0 }}>
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>

      {/* Следующие шаги */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Следующие шаги</p>
        {[
          { n: 1, text: 'Скачайте PDF-заявку ниже' },
          { n: 2, text: 'Подайте в ГУ МЧС по Камчатскому краю лично или через Госуслуги' },
          { n: 3, text: 'Перед выходом — убедитесь, что экстренный контакт знает дату вашего возврата' },
          { n: 4, text: 'По возвращении отметьте возврат в приложении (кнопка "Вернуться с маршрута")' },
        ].map(s => (
          <div key={s.n} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--danger)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>{s.n}</div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{s.text}</p>
          </div>
        ))}
      </div>

      <button onClick={onDownload} className="ds-btn ds-btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <Download size={15} /> Скачать PDF-заявку
      </button>

      {mchsPhone && (
        <a href={`tel:${mchsPhone.replace(/\D/g, '')}`} className="ds-btn ds-btn-secondary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none', textAlign: 'center' }}>
          МЧС Камчатка: {mchsPhone}
        </a>
      )}

      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>
        Закрыть
      </button>
    </div>
  );
}
