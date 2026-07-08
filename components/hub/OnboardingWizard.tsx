'use client';

import { ReactNode } from 'react';
import { Check, LucideIcon } from 'lucide-react';

/**
 * Общий каркас онбординг-визарда партнёрских кабинетов (gear/stay):
 * заголовок + горизонтальный степпер + карточка текущего шага.
 * Паттерн — из операторского онбординга (app/hub/operator/onboarding);
 * сам операторский клиент не рефакторится, живёт на своём коде.
 * Логика шагов — в конкретном визарде, компонент презентационный.
 */

export interface WizardStep {
  icon: LucideIcon;
  label: string;
}

export default function OnboardingWizard({
  title,
  subtitle,
  steps,
  current,
  children,
}: {
  title: string;
  subtitle?: string;
  steps: WizardStep[];
  current: number;
  children: ReactNode;
}) {
  const StepIcon = steps[current]?.icon ?? Check;
  const stepLabel = steps[current]?.label ?? '';

  return (
    <div className="max-w-lg mx-auto px-4 py-10">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold font-playfair text-[var(--text-primary)] mb-2">{title}</h1>
        {subtitle && <p className="text-sm text-[var(--text-secondary)]">{subtitle}</p>}
      </div>

      {/* Stepper */}
      <div className="flex items-center mb-8">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const done = i < current;
          const active = i === current;
          return (
            <div key={s.label} className="flex items-center flex-1 last:flex-none">
              <div className={`flex items-center gap-2 ${active ? 'text-[var(--accent)]' : done ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-colors ${
                  active ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                  : done  ? 'border-[var(--success)] bg-[var(--success)]/10'
                  : 'border-[var(--border)]'
                }`}>
                  {done ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Icon className="w-4 h-4" />}
                </div>
                <span className="text-xs font-medium hidden sm:block">{s.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div className={`flex-1 h-px mx-3 transition-colors ${done ? 'bg-[var(--success)]' : 'bg-[var(--border)]'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <StepIcon className="w-5 h-5 text-[var(--accent)]" />
          <h2 className="font-semibold text-[var(--text-primary)]">{stepLabel}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}
