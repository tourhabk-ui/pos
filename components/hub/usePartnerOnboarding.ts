'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Хуки онбординга партнёрских кабинетов (gear/stay) поверх
 * GET/PATCH /api/partners/profile.
 *
 * useOnboardingGuard — для дашбордов: незавершённый онбординг уводит в
 * визард; рендер и загрузка данных ждут результата (ready), чтобы не было
 * ни вспышки дашборда перед редиректом, ни ГОНКИ двух параллельных
 * авто-создающих фетчей (у partners нет уникального индекса
 * user_id+category — параллельные ensure-запросы могут задвоить профиль).
 * Ошибка/403 (не-партнёр, админ) не блокируют кабинет — ready=true.
 *
 * usePartnerOnboarding — для визардов: загрузка профиля, редирект уже
 * завершивших, завершение онбординга.
 */

export interface OnboardingPartner {
  id: string;
  name: string;
  description: string | null;
  contact: Record<string, string> | null;
  onboarding_completed?: boolean;
}

interface ProfileResponse {
  success?: boolean;
  data?: { partner?: OnboardingPartner };
}

export function useOnboardingGuard(onboardingPath: string): boolean {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/partners/profile')
      .then(r => (r.ok ? r.json() : null))
      .then((d: ProfileResponse | null) => {
        if (cancelled) return;
        const partner = d?.data?.partner;
        if (partner && !partner.onboarding_completed) {
          router.replace(onboardingPath);
        } else {
          setReady(true);
        }
      })
      .catch(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [router, onboardingPath]);

  return ready;
}

export function usePartnerOnboarding(hubPath: string) {
  const router = useRouter();
  const [profile, setProfile] = useState<OnboardingPartner | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/partners/profile')
      .then(r => (r.ok ? r.json() : null))
      .then((d: ProfileResponse | null) => {
        if (cancelled) return;
        const partner = d?.data?.partner;
        if (partner) {
          if (partner.onboarding_completed) {
            router.replace(hubPath);
            return;
          }
          setProfile(partner);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [router, hubPath]);

  async function completeOnboarding(redirectTo: string) {
    await fetch('/api/partners/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ complete_onboarding: true }),
    }).catch(() => {});
    router.replace(redirectTo);
  }

  return { profile, loading, completeOnboarding };
}
