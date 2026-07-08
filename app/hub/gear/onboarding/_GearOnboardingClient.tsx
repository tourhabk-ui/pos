'use client';

import { useState } from 'react';
import { Building2, Package, Loader2, Check } from 'lucide-react';
import OnboardingWizard from '@/components/hub/OnboardingWizard';
import PartnerProfileStep from '@/components/hub/PartnerProfileStep';
import { usePartnerOnboarding } from '@/components/hub/usePartnerOnboarding';

/**
 * Онбординг проката снаряжения: профиль → первый товар.
 * Завершение ставит partners.onboarding_completed (миграция 052 — поле
 * общее для всех партнёрских ролей).
 */

const STEPS = [
  { icon: Building2, label: 'Профиль проката' },
  { icon: Package, label: 'Первый товар' },
];

export default function GearOnboardingClient() {
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const { profile, loading, completeOnboarding } = usePartnerOnboarding('/hub/gear');

  async function finish(goToInventory: boolean) {
    setFinishing(true);
    await completeOnboarding(goToInventory ? '/hub/gear/inventory' : '/hub/gear');
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
      title="Настройка проката"
      subtitle="Два шага — и снаряжение на витрине"
      steps={STEPS}
      current={step}
    >
      {step === 0 && (
        <PartnerProfileStep
          profile={profile}
          namePlaceholder="Прокат «Вершина»"
          onNext={() => setStep(1)}
        />
      )}
      {step === 1 && (
        <div className="space-y-5">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            Добавьте первую позицию в инвентарь — палатку, ботинки, спутниковый
            коммуникатор. Товар сразу появится на витрине проката, а заявки на
            аренду будут приходить в раздел «Аренды».
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
              К инвентарю
            </button>
          </div>
        </div>
      )}
    </OnboardingWizard>
  );
}
