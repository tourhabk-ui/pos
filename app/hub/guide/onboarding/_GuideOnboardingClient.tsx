'use client';

import { useState } from 'react';
import { User, Compass, Loader2, Check } from 'lucide-react';
import OnboardingWizard from '@/components/hub/OnboardingWizard';
import PartnerProfileStep from '@/components/hub/PartnerProfileStep';
import { usePartnerOnboarding } from '@/components/hub/usePartnerOnboarding';

/**
 * Онбординг гида: профиль → следующие шаги. Завершение ставит
 * partners.onboarding_completed (миграция 052 — поле общее для всех ролей).
 * Заодно закрывает прежнюю мёртвую форму «Профиль» на дашборде — реальный
 * захват профиля теперь здесь.
 */

const STEPS = [
  { icon: User, label: 'Профиль гида' },
  { icon: Compass, label: 'Готово' },
];

export default function GuideOnboardingClient() {
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const { profile, loading, completeOnboarding, completeError } = usePartnerOnboarding('/hub/guide');

  async function finish() {
    setFinishing(true);
    const ok = await completeOnboarding('/hub/guide');
    if (!ok) setFinishing(false);
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
      title="Настройка профиля гида"
      subtitle="Заполните профиль — и можно принимать группы"
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
          namePlaceholder="Иван Камчатский, гид"
          onNext={() => setStep(1)}
        />
      )}
      {step === 1 && (
        <div className="space-y-5">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            Профиль сохранён. Нажав «В кабинет гида», вы отправите профиль на
            проверку платформы: в реестре гидов на сайте показываются только
            одобренные. Аттестат с датой выдачи добавьте в разделе «Профиль» —
            по ней видно, нужна ли переаттестация до 1 октября.
          </p>
          <button
            onClick={finish}
            disabled={finishing}
            className="w-full flex items-center justify-center gap-2 py-3 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
          >
            {finishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            В кабинет гида
          </button>
        </div>
      )}
    </OnboardingWizard>
  );
}
