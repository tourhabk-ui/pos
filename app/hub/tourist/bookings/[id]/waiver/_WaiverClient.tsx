'use client';

import { useState, useEffect, useCallback, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ShieldAlert, ArrowLeft, Loader2, BadgeCheck, FileText, TriangleAlert,
} from 'lucide-react';

// Вейвер — свойство безопасности (§7 vedar): осознанное согласие с рисками +
// медицинская декларация перед высокорисковым туром. Данные нужны гиду и МЧС
// при ЧП, а не «для галочки». Красим строго семантично: предупреждение —
// warning, подтверждение — success. Не выдумываем статус: всё из API.

interface WaiverData {
  signer_name: string;
  fit_to_participate: boolean;
  medical_conditions: string | null;
  allergies: string | null;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  signed_at: string;
}

interface StatusPayload {
  required: boolean;
  signed: boolean;
  reason: string | null;
  tourTitle: string;
  defaultSignerName: string;
  waiver: WaiverData | null;
}

export default function WaiverClient({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [signerName, setSignerName] = useState('');
  const [medicalConditions, setMedicalConditions] = useState('');
  const [allergies, setAllergies] = useState('');
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [risksAck, setRisksAck] = useState(false);
  const [fit, setFit] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/bookings/${bookingId}/waiver`);
        if (res.status === 404) { if (active) setNotFound(true); return; }
        const json = (await res.json()) as { success: boolean; data?: StatusPayload };
        if (!active) return;
        if (!json.success || !json.data) { setNotFound(true); return; }
        setStatus(json.data);
        const w = json.data.waiver;
        setSignerName(w?.signer_name ?? json.data.defaultSignerName ?? '');
        setMedicalConditions(w?.medical_conditions ?? '');
        setAllergies(w?.allergies ?? '');
        setEmergencyName(w?.emergency_contact_name ?? '');
        setEmergencyPhone(w?.emergency_contact_phone ?? '');
      } catch {
        if (active) setNotFound(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [bookingId]);

  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!risksAck || !fit) {
      setError('Подтвердите осознание рисков и пригодность к участию');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/waiver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signerName,
          risksAcknowledged: true,
          fitToParticipate: true,
          medicalConditions: medicalConditions || null,
          allergies: allergies || null,
          emergencyContactName: emergencyName,
          emergencyContactPhone: emergencyPhone,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) { setError(json.error ?? 'Не удалось сохранить согласие'); return; }
      router.push('/hub/tourist/bookings');
      router.refresh();
    } catch {
      setError('Ошибка сети. Попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  }, [bookingId, risksAck, fit, signerName, medicalConditions, allergies, emergencyName, emergencyPhone, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (notFound || !status) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="ds-card text-center py-14">
          <p className="text-[var(--text-secondary)]">Бронирование не найдено или недоступно.</p>
          <Link href="/hub/tourist/bookings" className="ds-btn ds-btn-secondary inline-flex mt-5">
            К бронированиям
          </Link>
        </div>
      </div>
    );
  }

  // Тур не высокорисковый — вейвер не нужен, честно об этом говорим.
  if (!status.required) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="ds-card text-center py-14">
          <BadgeCheck className="w-10 h-10 mx-auto mb-3 text-[var(--success)]" />
          <p className="text-[var(--text-primary)] font-medium">Для этого тура согласие с рисками не требуется.</p>
          <p className="text-sm text-[var(--text-secondary)] mt-1">{status.tourTitle}</p>
          <Link href="/hub/tourist/bookings" className="ds-btn ds-btn-secondary inline-flex mt-5">
            К бронированиям
          </Link>
        </div>
      </div>
    );
  }

  const alreadySigned = status.signed;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">
      <Link
        href="/hub/tourist/bookings"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
      >
        <ArrowLeft size={15} /> К бронированиям
      </Link>

      <header>
        <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">
          Согласие с рисками
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">{status.tourTitle}</p>
      </header>

      {/* Предупреждение о риске — семантический warning, не украшение */}
      <div className="flex items-start gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-4">
        <TriangleAlert className="w-5 h-5 text-[var(--warning)] flex-shrink-0 mt-0.5" />
        <p className="text-sm text-[var(--text-secondary)]">
          Это высокорисковый тур{status.reason ? ` (${status.reason})` : ''}. Участие сопряжено с
          опасностью для жизни и здоровья: сложный рельеф, погода, удалённость от медицинской
          помощи. Заполните декларацию — эти данные получат гид и, при ЧП, спасатели.
        </p>
      </div>

      {alreadySigned && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/10 p-4">
          <div className="flex items-center gap-2">
            <BadgeCheck className="w-5 h-5 text-[var(--success)]" />
            <p className="text-sm text-[var(--text-primary)] font-medium">
              Согласие подписано{status.waiver ? ` ${new Date(status.waiver.signed_at).toLocaleDateString('ru-RU')}` : ''}
            </p>
          </div>
          <a
            href={`/api/bookings/${bookingId}/waiver/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--ocean)] hover:underline whitespace-nowrap"
          >
            <FileText size={14} /> PDF
          </a>
        </div>
      )}

      <form onSubmit={handleSubmit} className="ds-card space-y-5">
        <div>
          <label className="ds-label" htmlFor="signer">ФИО участника</label>
          <input
            id="signer" type="text" value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            required minLength={2} className="ds-input mt-1.5"
            placeholder="Иванов Иван Иванович"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="ds-label" htmlFor="em-name">Экстренный контакт</label>
            <input
              id="em-name" type="text" value={emergencyName}
              onChange={(e) => setEmergencyName(e.target.value)}
              required minLength={2} className="ds-input mt-1.5"
              placeholder="Имя близкого человека"
            />
          </div>
          <div>
            <label className="ds-label" htmlFor="em-phone">Телефон контакта</label>
            <input
              id="em-phone" type="tel" value={emergencyPhone}
              onChange={(e) => setEmergencyPhone(e.target.value)}
              required minLength={5} className="ds-input mt-1.5"
              placeholder="+7 900 000-00-00"
            />
          </div>
        </div>

        <div>
          <label className="ds-label" htmlFor="medical">
            Хронические заболевания <span className="text-[var(--text-muted)] font-normal">(необязательно)</span>
          </label>
          <textarea
            id="medical" value={medicalConditions}
            onChange={(e) => setMedicalConditions(e.target.value)}
            rows={2} maxLength={2000} className="ds-input mt-1.5 resize-y"
            placeholder="Астма, болезни сердца, эпилепсия… — важно для спасателей"
          />
        </div>

        <div>
          <label className="ds-label" htmlFor="allergies">
            Аллергии <span className="text-[var(--text-muted)] font-normal">(необязательно)</span>
          </label>
          <textarea
            id="allergies" value={allergies}
            onChange={(e) => setAllergies(e.target.value)}
            rows={2} maxLength={1000} className="ds-input mt-1.5 resize-y"
            placeholder="Лекарства, укусы, продукты…"
          />
        </div>

        <div className="space-y-3 pt-1">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox" checked={risksAck}
              onChange={(e) => setRisksAck(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-[var(--accent)]"
            />
            <span className="text-sm text-[var(--text-secondary)]">
              Я осознаю риски участия в высокорисковом туре и обязуюсь выполнять указания гида
              и требования безопасности.
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox" checked={fit}
              onChange={(e) => setFit(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-[var(--accent)]"
            />
            <span className="text-sm text-[var(--text-secondary)]">
              Я подтверждаю, что физически пригоден(на) к участию, а указанные медицинские
              сведения достоверны.
            </span>
          </label>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-[var(--danger)]">
            <ShieldAlert size={15} /> {error}
          </div>
        )}

        <button
          type="submit" disabled={submitting}
          className="ds-btn ds-btn-primary w-full inline-flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <BadgeCheck className="w-4 h-4" />}
          {alreadySigned ? 'Обновить согласие' : 'Подписать согласие'}
        </button>
      </form>
    </div>
  );
}
