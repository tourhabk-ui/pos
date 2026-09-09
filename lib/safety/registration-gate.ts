/**
 * lib/safety/registration-gate.ts
 *
 * ОДНО правило: кто вправе трогать чужую регистрацию маршрута.
 *
 * Регистрацию заводит турист, а сообщение об эскалации уходит ЭКСТРЕННОМУ
 * КОНТАКТУ — человеку, у которого нашего аккаунта нет и не будет. Значит
 * второй ключ, кроме JWT, обязателен: им служит номер телефона руководителя
 * группы (контакт его знает по определению, посторонний с UUID из ссылки —
 * нет).
 *
 * Правило живёт здесь одно, потому что употребляется в трёх местах
 * (`/api/safety/return`, `/api/safety/route-checkin`, `/api/safety/mchs-informed`).
 * Правило, написанное трижды, — это три правила, и они разойдутся (§12).
 *
 * Исходов ТРИ, не два (§4.0):
 *   ok            — доказательство есть (аккаунт или номер);
 *   phone_required — номера не дали вовсе: это не «нельзя», это «не хватает
 *                    данных», и человеку надо показать поле ввода;
 *   phone_mismatch — номер дали, и он другой.
 * Слить два последних в одно «403 запрещено» — значит увести контакта в
 * тупик: именно так и было до 09.09, когда страница `/return` вообще не
 * имела поля для номера, а сообщение уже писало «понадобится номер
 * руководителя».
 */

import { timingSafeCompare } from '@/lib/security/timing-safe';

export type RegistrationGateResult =
  | { ok: true; via: 'owner' | 'leader_phone' }
  | { ok: false; reason: 'phone_required'; message: string }
  | { ok: false; reason: 'phone_mismatch'; message: string };

export interface RegistrationGateInput {
  /** userId из JWT, если запрос авторизован. */
  authedUserId: string | null;
  /** Владелец регистрации (может быть null — регистрируют и без аккаунта). */
  registrationUserId: string | null;
  /** Номер руководителя из БД. */
  leaderPhone: string | null;
  /** Номер, который прислал клиент. */
  providedPhone: string | null | undefined;
}

/**
 * Российские номера пишут и как «+7 914...», и как «8 914...» — это ОДИН
 * номер. Сравнение «только цифры» их развело бы, и контакт, набравший
 * привычную восьмёрку, получил бы отказ на верном номере.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length < 10) return null;
  return digits;
}

export function checkRegistrationGate(input: RegistrationGateInput): RegistrationGateResult {
  if (input.authedUserId && input.registrationUserId && input.authedUserId === input.registrationUserId) {
    return { ok: true, via: 'owner' };
  }

  const provided = normalizePhone(input.providedPhone);
  if (!provided) {
    return {
      ok: false,
      reason: 'phone_required',
      message: 'Укажите номер телефона руководителя группы — им подтверждается отметка без входа в аккаунт',
    };
  }

  const stored = normalizePhone(input.leaderPhone);
  if (stored && timingSafeCompare(provided, stored)) {
    return { ok: true, via: 'leader_phone' };
  }

  return {
    ok: false,
    reason: 'phone_mismatch',
    message: 'Номер не совпадает с номером руководителя группы в регистрации',
  };
}
