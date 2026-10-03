/**
 * Текст для формы МЧС из записи кабинета оператора (владелец 30.09, «по мчс 2»):
 * Ведар готовит данные группы, отправляет оператор сам. Шапка —
 * lib/safety/mchs-form-text.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mchsFormText, MCHS_NOT_IN_RECORD } from '@/lib/safety/mchs-form-text';
import { MCHS_LEAD_WORKING_DAYS } from '@/lib/safety/mchs-registration';

const rec = {
  route: 'Авачинский перевал — вулкан Авачинский — Авачинский перевал',
  startDate: '2026-10-12',
  endDate: '2026-10-13T00:00:00.000Z',
  groupComposition: [
    { fullName: 'Иванов Иван Иванович', birthDate: '1990-05-01', phone: '+7 900 000-00-01' },
    { fullName: 'Петрова Анна', phone: '' },
  ],
  guideContacts: { name: 'Сидоров Пётр', phone: '+7 900 000-00-09' },
  emergencyContacts: [{ name: 'Иванова Мария', phone: '+7 900 000-00-02', relation: 'жена' }],
};

describe('текст для формы МЧС', () => {
  const t = mchsFormText(rec);

  it('даты по-русски, маршрут, руководитель, все участники по номерам', () => {
    expect(t).toContain('Даты: 12.10.2026 — 13.10.2026');
    expect(t).toContain(`Маршрут: ${rec.route}`);
    expect(t).toContain('Руководитель группы (гид): Сидоров Пётр, тел. +7 900 000-00-09');
    expect(t).toContain('Участники (2):');
    expect(t).toContain('1. Иванов Иван Иванович, дата рождения 01.05.1990, тел. +7 900 000-00-01');
    // Пустое поле не оставляет висящей запятой и «тел. ».
    expect(t).toContain('2. Петрова Анна\n');
  });

  it('экстренный контакт с родством', () => {
    expect(t).toContain('— Иванова Мария (жена), тел. +7 900 000-00-02');
  });

  it('чего в записи нет, названо вслух, а не пропущено (§4.0)', () => {
    for (const miss of MCHS_NOT_IN_RECORD) expect(t).toContain(miss);
    expect(t).toMatch(/заполните в форме МЧС/);
  });

  it('срок подачи — из общего модуля, не своим числом', () => {
    expect(t).toContain(`за ${MCHS_LEAD_WORKING_DAYS} рабочих дней`);
  });

  it('нет руководителя и контактов — так и сказано', () => {
    const t2 = mchsFormText({ ...rec, guideContacts: null, emergencyContacts: [] });
    expect(t2).toContain('Руководитель группы: не указан');
    expect(t2).toContain('— не указаны');
  });

  it('текст без разметки и эмодзи — уходит в чужую форму как есть', () => {
    expect(t).not.toMatch(/[*_<>#]/);
    expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('кабинет оператора', () => {
  const PANEL = readFileSync(join(process.cwd(), 'components/operator/Dashboard/MchsRegistrationPanel.tsx'), 'utf-8');

  it('копирует тот же текст, что показывает, и ведёт на официальную форму из общего модуля', () => {
    expect(PANEL).toContain('navigator.clipboard.writeText(mchsFormText(selectedDetails))');
    expect(PANEL).toContain('{mchsFormText(selectedDetails)}');
    expect(PANEL).toContain('href={MCHS_ONLINE_FORM_URL}');
  });

  it('отказ буфера — подсказка, а не молчаливое «скопировано»', () => {
    expect(PANEL).toMatch(/setCopyState\('failed'\)/);
    expect(PANEL).toContain('Не удалось скопировать автоматически');
  });

  it('ничего не отправляет в МЧС сам', () => {
    expect(PANEL).not.toMatch(/fetch\([^)]*mchs\.gov\.ru/);
  });
});

describe('самостоятельная группа (/register, 03.10)', () => {
  it('руководитель не называется гидом, год рождения — годом', async () => {
    const { mchsFormText } = await import('@/lib/safety/mchs-form-text');
    const t = mchsFormText({
      route: 'Вулкан Горелый', startDate: '2026-10-05', endDate: '2026-10-05', leaderRole: 'self',
      guideContacts: { name: 'Иванов Иван', phone: '+7 900 000-00-01' },
      groupComposition: [{ fullName: 'Иванов Иван', birthDate: '1990' }],
      emergencyContacts: [],
    });
    expect(t).toContain('Руководитель группы: Иванов Иван');
    expect(t).not.toContain('(гид)');
    expect(t).toContain('год рождения 1990');
  });

  it('экран регистрации отдаёт текст формы и ссылку для контакта', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/register/page.tsx', 'utf8');
    expect(src).toMatch(/mchsFormText\(\{/);
    expect(src).toMatch(/leaderRole: 'self'/);
    expect(src).toMatch(/\/watch\?id=\$\{registrationId\}/);
  });
});
