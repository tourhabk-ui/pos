/**
 * Синтетическая проверка safety-флоу на живой системе.
 *
 * Зелёный CI и прод-smoke доказывают, что страницы отдаются, но НЕ доказывают,
 * что главное обещание платформы — безопасность — реально работает с боевыми
 * данными. Этот модуль прогоняет ИНВАРИАНТЫ safety-путей: детерминированные
 * (SOS-детектор, экстренные номера — код, который не имеет права сломаться) и
 * данные (покупаемый тур, телефон МЧС на маршрутах с обязательной регистрацией,
 * профили безопасности мест). Дайджест 21.07: «агенты работают в тестах, падают
 * в проде — тестировать интеграции». Это ловит ровно такие регрессии.
 *
 * Никаких сайд-эффектов: только чтение БД и чистые вызовы. Лидов/броней не
 * создаёт.
 */

import { pool } from '@/lib/db-pool';
import { withSosBlock } from './sos-detector';
import { EMERGENCY_PRIMARY, FEDERAL_EMERGENCY } from './emergency-numbers';

export type CheckLevel = 'critical' | 'warn';

export interface SafetyCheck {
  id: string;
  level: CheckLevel;
  pass: boolean;
  detail: string;
}

export interface SafetyCheckReport {
  ok: boolean;
  criticalFail: boolean;
  checks: SafetyCheck[];
}

// «112» отдельным числом (не кусок цены «11200») — тот же тест, что HAS_EMERGENCY_PHONES.
const RE_112 = /(?<!\d)112(?!\d)/;
const RE_MCHS = /мчс/i;

/**
 * Детерминированные проверки — без БД, работают всегда (offline-first).
 * Ядро обещания: SOS-детектор и экстренные номера. Если это сломается —
 * турист в ЧП не получит 112. Уровень critical.
 */
export function runDeterministicSafetyChecks(): SafetyCheck[] {
  const checks: SafetyCheck[] = [];

  // 1. SOS срабатывает на ЧП и выдаёт 112 + МЧС
  const emergencies = [
    'на меня вышел медведь, он рядом',
    'сломал ногу, застрял на склоне',
    'заблудился, не знаю где я',
    'SOS терплю бедствие',
    'нас накрыло лавиной',
  ];
  const failedFire = emergencies.filter((phrase) => {
    const r = withSosBlock('Спасибо за вопрос.', phrase);
    return !(r.emergency && RE_112.test(r.text) && RE_MCHS.test(r.text));
  });
  checks.push({
    id: 'sos_fires_on_emergency',
    level: 'critical',
    pass: failedFire.length === 0,
    detail: failedFire.length
      ? `не сработал/без 112: ${failedFire.join(' | ')}`
      : `${emergencies.length}/${emergencies.length} ЧП → 112 + МЧС`,
  });

  // 2. SOS молчит на бытовых (нет ложных тревог)
  const benign = [
    'сколько стоит тур на Авачинский',
    'какая погода на выходных',
    'посоветуй маршрут одного дня',
  ];
  const falsePos = benign.filter((phrase) => withSosBlock('ответ', phrase).emergency);
  checks.push({
    id: 'sos_silent_on_benign',
    level: 'critical',
    pass: falsePos.length === 0,
    detail: falsePos.length ? `ложное срабатывание: ${falsePos.join(' | ')}` : `${benign.length} бытовых фраз — тихо`,
  });

  // 3. Экстренные номера канон: 112 первичный и в федеральном наборе
  const numbersOk = EMERGENCY_PRIMARY.phone === '112' && FEDERAL_EMERGENCY.some((n) => n.phone === '112');
  checks.push({
    id: 'emergency_numbers_canonical',
    level: 'critical',
    pass: numbersOk,
    detail: numbersOk
      ? `112 первичный, федеральный набор из ${FEDERAL_EMERGENCY.length}`
      : `112 не первичный номер — регресс!`,
  });

  return checks;
}

/**
 * Проверки на живых данных (чтение). БД недоступна → warn, не падаем
 * (offline-first: сама проверка не должна ронять систему).
 */
async function runDbSafetyChecks(): Promise<SafetyCheck[]> {
  const checks: SafetyCheck[] = [];

  // 4. Есть покупаемый тур — данные booking happy-path целы
  try {
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM operator_tours
        WHERE deleted_at IS NULL AND is_active = true AND base_price > 0`,
    );
    const n = parseInt(r.rows[0]?.n ?? '0', 10);
    checks.push({
      id: 'bookable_tour_exists',
      level: 'warn',
      pass: n > 0,
      detail: `${n} активных туров с ценой`,
    });
  } catch (e) {
    checks.push({ id: 'bookable_tour_exists', level: 'warn', pass: false, detail: `БД недоступна: ${(e as Error).message}` });
  }

  // 5. МЧС-инвариант: маршрут, требующий регистрации МЧС, обязан дать телефон
  //    (турист, которому сказали «зарегистрируйтесь в МЧС» без номера — дыра).
  try {
    const r = await pool.query<{ missing: string; total: string }>(
      `SELECT
         (COUNT(*) FILTER (WHERE mchs_phone IS NULL OR mchs_phone = ''))::text AS missing,
         COUNT(*)::text AS total
       FROM kamchatka_routes
      WHERE mchs_registration_required = true AND is_visible = true`,
    );
    const missing = parseInt(r.rows[0]?.missing ?? '0', 10);
    const total = parseInt(r.rows[0]?.total ?? '0', 10);
    checks.push({
      id: 'mchs_routes_have_phone',
      level: 'warn',
      pass: missing === 0,
      detail: missing ? `${missing} из ${total} МЧС-маршрутов без телефона` : `все ${total} МЧС-маршрутов с телефоном`,
    });
  } catch (e) {
    checks.push({ id: 'mchs_routes_have_phone', level: 'warn', pass: false, detail: `БД недоступна: ${(e as Error).message}` });
  }

  // 6. Профили безопасности мест присутствуют (карточка точки покажет опасности)
  try {
    const r = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM location_safety_profile`);
    const n = parseInt(r.rows[0]?.n ?? '0', 10);
    checks.push({ id: 'safety_profiles_present', level: 'warn', pass: n > 0, detail: `${n} профилей безопасности мест` });
  } catch (e) {
    checks.push({ id: 'safety_profiles_present', level: 'warn', pass: false, detail: `БД недоступна: ${(e as Error).message}` });
  }

  return checks;
}

/** Полный прогон: детерминированные инварианты + проверки на живых данных. */
export async function runSafetySelfCheck(): Promise<SafetyCheckReport> {
  const checks = [...runDeterministicSafetyChecks(), ...(await runDbSafetyChecks())];
  const criticalFail = checks.some((c) => c.level === 'critical' && !c.pass);
  return { ok: checks.every((c) => c.pass), criticalFail, checks };
}
