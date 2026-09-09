/**
 * Отметки на регистрации маршрута: одно правило доступа, три исхода, и поле
 * для номера там, где номер требуют.
 *
 * ── Чем это оплачено ───────────────────────────────────────────────────────
 *
 * Сообщение об эскалации уходит ЭКСТРЕННОМУ КОНТАКТУ — человеку без нашего
 * аккаунта. В тексте стояло «отметьте возвращение (понадобится номер
 * руководителя)», API без номера отвечал 403, а на странице `/return` поля
 * для номера не было ВООБЩЕ. То есть единственный получатель тревоги не мог
 * снять её ничем: петля безопасности была разомкнута на последнем шаге, и
 * разомкнута молча.
 *
 * Второе: правило доступа лежало внутри одного роута. Отметок стало три
 * (возврат, «мы в порядке», «сообщил в МЧС») — правило, переписанное трижды,
 * это три правила, и они разойдутся (§12).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkRegistrationGate, normalizePhone } from '@/lib/safety/registration-gate';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('правило доступа к отметке', () => {
  const base = {
    authedUserId: null,
    registrationUserId: 'user-1',
    leaderPhone: '+7 914 111-22-33',
  };

  it('владелец аккаунта проходит без номера', () => {
    const r = checkRegistrationGate({ ...base, authedUserId: 'user-1', providedPhone: undefined });
    expect(r).toEqual({ ok: true, via: 'owner' });
  });

  it('чужой аккаунт сам по себе не пускает', () => {
    const r = checkRegistrationGate({ ...base, authedUserId: 'user-2', providedPhone: undefined });
    expect(r.ok).toBe(false);
  });

  it('номер руководителя пускает без входа — это и есть ключ экстренного контакта', () => {
    const r = checkRegistrationGate({ ...base, providedPhone: '+7 (914) 111-22-33' });
    expect(r).toEqual({ ok: true, via: 'leader_phone' });
  });

  it('восьмёрка и +7 — один номер, а не два', () => {
    expect(normalizePhone('8 914 111-22-33')).toBe('79141112233');
    expect(normalizePhone('+7 914 111 22 33')).toBe('79141112233');
    expect(normalizePhone('9141112233')).toBe('79141112233');
    const r = checkRegistrationGate({ ...base, providedPhone: '8 914 111 22 33' });
    expect(r.ok).toBe(true);
  });

  it('исходов ТРИ: «не дали номер» и «номер не тот» — разные состояния', () => {
    const none = checkRegistrationGate({ ...base, providedPhone: '' });
    const wrong = checkRegistrationGate({ ...base, providedPhone: '+7 914 999-88-77' });
    expect(none.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    expect(none.ok === false && none.reason).toBe('phone_required');
    expect(wrong.ok === false && wrong.reason).toBe('phone_mismatch');
    // Слить их в одно «запрещено» значит увести контакта в тупик: по первому
    // исходу надо показать ПОЛЕ, по второму — сообщение об ошибке.
    expect(none.ok === false && none.message).not.toBe(wrong.ok === false && wrong.message);
  });

  it('мусор вместо номера считается отсутствием номера, а не несовпадением', () => {
    const r = checkRegistrationGate({ ...base, providedPhone: '123' });
    expect(r.ok === false && r.reason).toBe('phone_required');
  });
});

describe('правило живёт в одном месте', () => {
  const ROUTES = [
    'app/api/safety/return/route.ts',
    'app/api/safety/route-checkin/route.ts',
    'app/api/safety/mchs-informed/route.ts',
  ];

  it('все три отметки ходят через общий вход', () => {
    for (const p of ROUTES) {
      expect(existsSync(join(process.cwd(), p)), `нет роута ${p}`).toBe(true);
      expect(read(p), p).toContain('openRegistrationForMark');
    }
  });

  it('ни один роут не сверяет номер сам', () => {
    for (const p of ROUTES) {
      // Своя нормализация — это второе правило: оно не узнает про восьмёрку
      // и разойдётся с общим при первой же правке.
      expect(read(p), p).not.toMatch(/leader_phone\s*\.replace\(|replace\(\/\\D\/g/);
    }
  });
});

describe('где требуют номер — там его дают ввести', () => {
  const PAGES: Array<{ client: string; api: string }> = [
    { client: 'app/return/ReturnClient.tsx', api: '/api/safety/return' },
    { client: 'app/checkin-ok/CheckinOkClient.tsx', api: '/api/safety/route-checkin' },
  ];

  it('страница отметки шлёт leader_phone и имеет поле для него', () => {
    for (const { client, api } of PAGES) {
      const src = read(client);
      expect(src, client).toContain(api);
      expect(src, client).toContain('leader_phone');
      // Поле — общий компонент: иначе на второй странице заведут своё,
      // и ровно одна из двух окажется без ввода (как было у `/return`).
      expect(src, client).toContain('LeaderPhoneField');
    }
  });

  it('поле — настоящий input, а не подпись', () => {
    const field = read('components/safety/LeaderPhoneField.tsx');
    expect(field).toMatch(/<input/);
    expect(field).toContain('type="tel"');
  });
});

describe('отметка «сообщил в МЧС»', () => {
  it('отказ виден человеку, а не съеден пустым catch', () => {
    const src = read('app/return/ReturnClient.tsx');
    const handler = src.slice(src.indexOf('const handleMchsInformed'), src.indexOf('if (loading)'));
    expect(handler).toContain('setMchsError');
    // Молчаливый отказ здесь означал бы: человек уверен, что платформа знает
    // о его звонке в 112, а она не знает.
    expect(src).toMatch(/\{mchsError && \(/);
  });

  it('не гасит шаг МЧС — только предупреждает о дубле', () => {
    const route = read('app/api/safety/mchs-informed/route.ts');
    expect(route).not.toMatch(/completed_at\s*=/);
    expect(route).toContain('COALESCE(mchs_informed_at, now())');
    const esc = read('lib/safety/checkin-escalation.ts');
    expect(esc).toContain('mchsInformedText');
    expect(esc).toContain('не дублируйте обращение');
  });

  it('колонка заведена миграцией', () => {
    const mig = read('migrations/944_route_registrations_mchs_informed.sql');
    expect(mig).toContain('ADD COLUMN IF NOT EXISTS mchs_informed_at');
  });
});

describe('оба новых роута публичны на Edge', () => {
  it('иначе экстренный контакт получит 401 вместо страницы', () => {
    const registry = read('lib/auth/public-api-routes.ts');
    expect(registry).toContain("'/api/safety/route-checkin'");
    expect(registry).toContain("'/api/safety/mchs-informed'");
  });
});
