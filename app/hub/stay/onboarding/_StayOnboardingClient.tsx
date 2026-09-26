'use client';

import { useState } from 'react';
import { Building2, Home, Loader2 } from 'lucide-react';
import OnboardingWizard from '@/components/hub/OnboardingWizard';
import PartnerProfileStep from '@/components/hub/PartnerProfileStep';
import { usePartnerOnboarding } from '@/components/hub/usePartnerOnboarding';
import AccommodationCreateForm from '@/components/hub/AccommodationCreateForm';

/**
 * Онбординг владельца жилья: профиль → первый объект.
 * Объект создаётся общей формой (components/hub/AccommodationCreateForm) —
 * той же, что «Добавить объект» в кабинете; уходит на проверку платформы.
 */

const STEPS = [
  { icon: Building2, label: 'Профиль владельца' },
  { icon: Home, label: 'Первый объект' },
];

export default function StayOnboardingClient() {
  const [step, setStep] = useState(0);
  const { profile, loading, completeOnboarding, completeError } = usePartnerOnboarding('/hub/stay');

  async function finish(created: boolean) {
    await completeOnboarding(created ? '/hub/stay/accommodations' : '/hub/stay');
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (!profile) {
    return <div className="text-center py-20 text-[var(--text-secondary)]">Профиль не найден</div>;
  }

  return (
    <OnboardingWizard
      title="Кабинет владельца жилья"
      subtitle="Профиль и первый объект — и брони начнут приходить сюда"
      steps={STEPS}
      current={step}
    >
      {completeError && (
        <div role="alert" className="mb-4 p-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-sm text-[var(--text-primary)]">
          {completeError}
        </div>
      )}
      {step === 0 && (
        <PartnerProfileStep
          profile={profile}
          namePlaceholder="Гостевой дом «У вулкана»"
          onNext={() => setStep(1)}
        />
      )}
      {step === 1 && (
        <AccommodationCreateForm
          onCreated={() => finish(true)}
          secondary={{ label: 'Добавить позже', onClick: () => { void finish(false); } }}
        />
      )}
    </OnboardingWizard>
  );
}
