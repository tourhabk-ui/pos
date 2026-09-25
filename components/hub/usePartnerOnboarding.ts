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

  const [completeError, setCompleteError] = useState<string | null>(null);

  /**
   * Завершение онбординга. Переход — ТОЛЬКО после подтверждённой записи.
   *
   * Прежде отказ PATCH глушился `.catch(() => {})`, и визард всё равно уводил
   * в кабинет; гейт кабинета видел onboarding_completed = false и молча
   * возвращал обратно в визард — петля без единого слова о причине.
   * Теперь неудача возвращает false и кладёт текст в completeError.
   */
  async function completeOnboarding(redirectTo: string): Promise<boolean> {
    setCompleteError(null);
    try {
      const res = await fetch('/api/partners/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ complete_onboarding: true }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || (json as { success?: boolean } | null)?.success !== true) {
        const msg = (json as { error?: string } | null)?.error;
        setCompleteError(msg ?? `Не удалось завершить настройку (HTTP ${res.status}). Попробуйте ещё раз.`);
        return false;
      }
    } catch {
      setCompleteError('Сеть недоступна — настройка не завершена. Попробуйте ещё раз.');
      return false;
    }
    router.replace(redirectTo);
    return true;
  }

  return { profile, loading, completeOnboarding, completeError };
}
