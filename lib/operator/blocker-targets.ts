/**
 * Куда ведёт каждый блокер готовности тура — экран «Чего не хватает турам»
 * (решение владельца 13.10: «сделай экран „чего не хватает туру“ в кабинете»).
 *
 * Правило готовности одно (lib/tours/readiness: missingFields), и его коды
 * блокеров экран показывает словами (BLOCKER_LABELS). Но слов мало: оператор
 * должен в один клик попасть туда, где это чинится. Поэтому у КАЖДОГО кода
 * здесь назван адрес — якорь в редакторе тура, профиль компании или быстрое
 * поле. Код без адреса показался бы оператору строкой без кнопки; сторож
 * (tests/unit/completeness-screen.test.tsx) держит множества ключей равными.
 */
import { isQuickFillField } from '@/lib/operator/quick-fill-fields';

export type BlockerTarget =
  /** Секция редактора тура: /hub/operator/tours/<id>#<anchor>. */
  | { kind: 'editor'; anchor: string }
  /** Контакты компании — в профиле оператора, не в туре. */
  | { kind: 'profile' }
  /** Одна строка или число — быстрое поле прямо на экране (quick-fill). */
  | { kind: 'quick'; field: string };

export const BLOCKER_TARGETS: Record<string, BlockerTarget> = {
  title:               { kind: 'quick',  field: 'title' },
  // Триста знаков — не одна строка: в редактор, к полному описанию.
  description:         { kind: 'editor', anchor: 'basics' },
  photos:              { kind: 'editor', anchor: 'photos' },
  base_price:          { kind: 'quick',  field: 'base_price' },
  duration_hours:      { kind: 'quick',  field: 'duration_hours' },
  pickup:              { kind: 'editor', anchor: 'pickup' },
  pickup_details:      { kind: 'editor', anchor: 'pickup' },
  cancellation_policy: { kind: 'editor', anchor: 'cancellation' },
  coordinates:         { kind: 'editor', anchor: 'location' },
  operator_contact:    { kind: 'profile' },
};

/** Якоря редактора, на которые ссылается экран: у каждого обязан быть id в _EditTourClient. */
export const EDITOR_ANCHORS: readonly string[] = Array.from(new Set(
  Object.values(BLOCKER_TARGETS).flatMap((t) => (t.kind === 'editor' ? [t.anchor] : [])),
));

export const OPERATOR_PROFILE_PATH = '/hub/operator/profile';

/** Адрес перехода для блокера; у быстрого поля адреса нет — его заполняют на месте. */
export function blockerHref(field: string, tourId: string): string | null {
  const t = BLOCKER_TARGETS[field];
  if (!t) return `/hub/operator/tours/${tourId}`;
  if (t.kind === 'editor') return `/hub/operator/tours/${tourId}#${t.anchor}`;
  if (t.kind === 'profile') return OPERATOR_PROFILE_PATH;
  return null;
}

/** Быстрое поле — только если quick-fill его принимает (иначе в редактор). */
export function blockerQuickField(field: string): string | null {
  const t = BLOCKER_TARGETS[field];
  if (!t || t.kind !== 'quick') return null;
  return isQuickFillField(t.field) ? t.field : null;
}
