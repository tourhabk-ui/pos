'use client';

import { User, Loader2 } from 'lucide-react';
import OnboardingWizard from '@/components/hub/OnboardingWizard';
import PartnerProfileStep from '@/components/hub/PartnerProfileStep';
import { usePartnerOnboarding } from '@/components/hub/usePartnerOnboarding';

/**
 * Онбординг агента: один шаг — профиль агентства/контакты. Завершение ставит
 * partners.onboarding_completed. Профиль агента «тонкий» (идентичность на
 * user_id), поэтому только базовый профиль-шаг, дальше — сразу в кабинет.
 */

const STEPS = [{ icon: User, label: 'Профиль агентства' }];

export default function AgentOnboardingClient() {
  const { profile, loading, completeOnboarding, completeError } = usePartnerOnboarding('/hub/agent');

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
      title="Настройка агентского кабинета"
      subtitle="Заполните профиль — и можно работать с клиентами"
      steps={STEPS}
      current={0}
    >
      {completeError && (
        <div role="alert" className="mb-4 p-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-sm text-[var(--text-primary)]">
          {completeError}
        </div>
      )}
      <PartnerProfileStep
        profile={profile}
        namePlaceholder="Турагентство «Восток»"
        onNext={() => { void completeOnboarding('/hub/agent'); }}
      />
    </OnboardingWizard>
  );
}
