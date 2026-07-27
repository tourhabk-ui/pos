'use client';

import { useState } from 'react';
import { Building2, Car, Loader2, Check } from 'lucide-react';
import OnboardingWizard from '@/components/hub/OnboardingWizard';
import PartnerProfileStep from '@/components/hub/PartnerProfileStep';
import { usePartnerOnboarding } from '@/components/hub/usePartnerOnboarding';

/**
 * Онбординг трансфер-оператора: профиль → первая машина.
 * Тот же конвейер, что у gear/stay (partners.onboarding_completed);
 * до этого роль попадала в пустой кабинет без подсказки, с чего начать.
 */

const STEPS = [
  { icon: Building2, label: 'Профиль компании' },
  { icon: Car, label: 'Первая машина' },
];

export default function TransferOnboardingClient() {
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const { profile, loading, completeOnboarding } = usePartnerOnboarding('/hub/transfer-operator');

  async function finish(goToVehicles: boolean) {
    setFinishing(true);
    await completeOnboarding(goToVehicles ? '/hub/transfer-operator/vehicles' : '/hub/transfer-operator');
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
      title="Настройка кабинета трансферов"
      subtitle="Два шага — и можно принимать брони"
      steps={STEPS}
      current={step}
    >
      {step === 0 && (
        <PartnerProfileStep
          profile={profile}
          namePlaceholder="Трансферы «Камчатка»"
          onNext={() => setStep(1)}
        />
      )}
      {step === 1 && (
        <div className="space-y-5">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            Добавьте первую машину в автопарк — минивэн, автобус или внедорожник.
            Затем добавьте водителей и маршруты, а заявки пассажиров будут
            приходить в раздел «Брони».
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => finish(false)}
              disabled={finishing}
              className="flex-1 py-3 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            >
              Позже
            </button>
            <button
              onClick={() => finish(true)}
              disabled={finishing}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
            >
              {finishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              К автопарку
            </button>
          </div>
        </div>
      )}
    </OnboardingWizard>
  );
}
