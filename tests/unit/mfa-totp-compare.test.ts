/**
 * Сторож сверки TOTP и проверок владения оператора.
 *
 * js/user-controlled-bypass, 4 находки 23.08.2026. CodeQL пометил условия,
 * которыми управляет присланное значение. Обхода за ними не оказалось ни в
 * одном из четырёх мест — ворота везде другие:
 *
 *   mfa/verify:69       → воротами служит verifyTOTP (HMAC-SHA1, окно ±1 шаг,
 *                         5 попыток в минуту на адрес), а не проверка формы;
 *   max/kuzmich:222,223 → вся ветка входа доминируется opts.verifiedOrigin,
 *                         серверным флагом из isVerifiedMaxWebhook (секрет в
 *                         URL, timingSafeCompare, fail-closed при отсутствии
 *                         секрета). Поля апдейта читаются ПОСЛЕ гейта;
 *   operator/messages:32 → воротами служит verifyBookingOwnership —
 *                         параметризованный запрос через partners.user_id.
 *
 * Здесь закреплено то, что при разборе действительно оказалось поправимым:
 * сверка кода была `===` по строке (не постоянного времени), а четыре
 * проверки владения глушили отказ БД молча.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

// Сверка TOTP вынесена в lib/auth/totp.ts (P1, аудит 28.08) — второй шаг
// входа при MFA (app/api/auth/mfa/login-verify) переиспользует ту же
// функцию вместо второй копии алгоритма. Алгоритмические проверки смотрят
// в новый файл; лимит попыток остаётся заботой роута — смотрим оба.
const TOTP = strip(read('lib/auth/totp.ts'));
const MFA = strip(read('app/api/auth/mfa/verify/route.ts'));
const MFA_LOGIN = strip(read('app/api/auth/mfa/login-verify/route.ts'));
const HELPERS = strip(read('lib/auth/operator-helpers.ts'));
const MAX = strip(read('app/api/max/kuzmich/route.ts'));
const WEBHOOK = strip(read('lib/max/webhook-url.ts'));

describe('сверка кода TOTP', () => {
  it('сравнение постоянного времени, а не === по строке', () => {
    expect(TOTP).toMatch(/timingSafeEqual/);
    expect(TOTP, 'вернулось строковое сравнение кода')
      .not.toMatch(/generateTOTP\([^)]*\)\s*===/);
  });

  it('цикл по окну не прерывается досрочно', () => {
    // Ранний return вернул бы разное время для совпадения на первом и на
    // третьем шаге — то есть сам стал бы каналом утечки.
    const body = TOTP.slice(TOTP.indexOf('function verifyTOTP'));
    expect(body.slice(0, body.indexOf('\n}'))).not.toMatch(/return true;/);
  });

  it('код обязан быть шестизначным — иначе timingSafeEqual бросит', () => {
    expect(TOTP).toMatch(/\^\\d\{6\}\$/);
  });

  it('лимит попыток на месте', () => {
    expect(MFA).toMatch(/createRateLimiter/);
  });

  it('второй вход (MFA при логине) — тот же лимит и та же сверка, не копия', () => {
    expect(MFA_LOGIN).toMatch(/createRateLimiter/);
    expect(MFA_LOGIN).toMatch(/verifyTOTP/);
    expect(MFA_LOGIN, 'завёл вторую копию алгоритма вместо lib/auth/totp')
      .not.toMatch(/function generateTOTP/);
  });
});

describe('вход через MAX: решает серверный флаг', () => {
  it('ветка входа доминируется verifiedOrigin', () => {
    expect(MAX).toMatch(/opts\?\.verifiedOrigin === true\s*\n?\s*&&/);
  });

  it('флаг вычисляется на сервере, не берётся из тела апдейта', () => {
    expect(MAX).toMatch(/const verifiedOrigin = isVerifiedMaxWebhook\(request\.url\)/);
    expect(WEBHOOK).toMatch(/if \(!secret\) return false;/);
    expect(WEBHOOK).toMatch(/timingSafeCompare/);
  });
});

describe('проверки владения оператора: отказ не выдаётся за «прав нет»', () => {
  it('каждая проверка оставляет след при сбое', () => {
    for (const check of ['getOperatorPartnerId', 'getPartnerByUserId',
                         'verifyTourOwnership', 'verifyBookingOwnership']) {
      expect(HELPERS, `${check} снова молчит при отказе`)
        .toMatch(new RegExp(`logCheckFailure\\('${check}'`));
    }
  });

  it('в след попадает SQLSTATE', () => {
    expect(HELPERS).toMatch(/SQLSTATE/);
  });

  it('направление отказа осталось безопасным — в правах отказать, не выдать', () => {
    // Логирование не должно превратиться в «раз не смогли, пропустим».
    const bodies = HELPERS.split('catch (error) {').slice(1);
    for (const b of bodies) {
      const head = b.slice(0, b.indexOf('}'));
      expect(head, `проверка стала выдавать права при сбое: ${head.trim()}`)
        .not.toMatch(/return true;/);
    }
  });
});
