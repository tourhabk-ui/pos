'use client';

/**
 * Ворота кабинета оператора.
 *
 * Без профиля экран онбординга, дашборд, место в команде и баннер мессенджера
 * стартовали разом: 404 профиля, 403 на /me, канал и дашборд, и вспышка
 * «Профиль не найден». Пока профиль не прочитан, этих запросов нет.
 * Онбординг не завершён — тихий переход на настройку, без остальных экранов.
 * Это только владелец: менеджер компании форму не сохраняет и в кабинет входит.
 * Админ без своей компании партнёра не получает: одна фраза, как открыть кабинет.
 */
import { createContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const ONBOARDING = '/hub/operator/onboarding';

type Viewer = 'owner' | 'manager';

type Gate =
  | { kind: 'loading' }
  | { kind: 'ready'; at: boolean; viewer: Viewer; completed: boolean }
  | { kind: 'onboarding'; at: boolean }
  | { kind: 'admin'; at: boolean }
  | { kind: 'failed'; message: string; at: boolean };

/** Факт профиля, который ворота уже прочитали. Дашборд не выдумывает «заполнено». */
export const OperatorCabinetFacts = createContext<{
  onboardingCompleted: boolean;
  viewer: Viewer;
} | null>(null);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

async function readGate(at: boolean): Promise<Exclude<Gate, { kind: 'loading' }>> {
  let res: Response;
  try {
    res = await fetch('/api/hub/operator/profile');
  } catch {
    return { kind: 'failed', at, message: 'Нет связи — кабинет не открылся. Обновите страницу.' };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.status === 404 && isRecord(json) && json.code === 'admin_no_company') {
    return { kind: 'admin', at };
  }
  if (!res.ok) {
    const message = isRecord(json) && typeof json.error === 'string'
      ? json.error
      : 'Кабинет не открылся. Попробуйте ещё раз.';
    return { kind: 'failed', at, message };
  }
  const data = isRecord(json) ? json.data : null;
  const completed = isRecord(data) && data.onboarding_completed === true;
  const viewer: Viewer = isRecord(data) && data.viewer === 'manager' ? 'manager' : 'owner';
  if (completed || viewer === 'manager') return { kind: 'ready', at, viewer, completed };
  return { kind: 'onboarding', at };
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-16 text-center" role="status">
      <p className="text-sm text-[var(--text-secondary)]">{children}</p>
    </div>
  );
}

export function OperatorCabinetGate({
  children,
  quiet,
  ready,
}: {
  children: ReactNode;
  quiet: (node: ReactNode) => ReactNode;
  ready: (node: ReactNode) => ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const onOnboarding = pathname === ONBOARDING || (pathname?.startsWith(`${ONBOARDING}/`) ?? false);
  const [gate, setGate] = useState<Gate>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const at = onOnboarding;
    readGate(at).then((next) => {
      if (!cancelled) setGate(next);
    });
    return () => { cancelled = true; };
  }, [attempt, onOnboarding]);

  const stale = gate.kind !== 'loading' && gate.at !== onOnboarding;

  useEffect(() => {
    if (stale) return;
    if (gate.kind === 'onboarding' && !onOnboarding) router.replace(ONBOARDING);
  }, [gate, onOnboarding, router, stale]);

  if (gate.kind === 'loading' || stale) return <>{quiet(<Status>Открываем кабинет…</Status>)}</>;

  if (gate.kind === 'admin') {
    return <>{quiet(
      <Status>
        У этой учётной записи нет кабинета туроператора. Откройте его через «Войти как → Туроператор».
      </Status>,
    )}</>;
  }

  if (gate.kind === 'failed') {
    return <>{quiet(
      <div className="px-4 py-16 text-center space-y-3" role="alert">
        <p className="text-sm text-[var(--text-secondary)]">{gate.message}</p>
        <button
          type="button"
          onClick={() => { setGate({ kind: 'loading' }); setAttempt((n) => n + 1); }}
          className="ds-btn ds-btn-secondary min-h-[44px]"
        >
          Повторить
        </button>
      </div>,
    )}</>;
  }

  if (gate.kind === 'onboarding') {
    if (!onOnboarding) return <>{quiet(<Status>Открываем настройку профиля…</Status>)}</>;
    return <>{quiet(children)}</>;
  }

  const facts = { onboardingCompleted: gate.completed, viewer: gate.viewer };
  const body = gate.viewer === 'manager' && onOnboarding
    ? <Status>Настройку профиля завершает владелец компании. Разделы кабинета — в меню.</Status>
    : children;

  return (
    <OperatorCabinetFacts.Provider value={facts}>
      {ready(body)}
    </OperatorCabinetFacts.Provider>
  );
}
