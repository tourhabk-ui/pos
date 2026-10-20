import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Экстренный контакт: профиль туриста пишет, «Контрольный срок» (/register)
// читает и подставляет (аудит кабинета туриста 20.10).
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('экстренный контакт: профиль → регистрация маршрута', () => {
  it('профиль читает и сохраняет поля экстренного контакта', () => {
    const helper = read('lib/auth/tourist-helpers.ts');
    expect(helper).toMatch(/emergency_contact_name, emergency_contact_phone, emergency_contact_relation/);
    const ui = read('app/hub/tourist/profile/_ProfileClient.tsx');
    expect(ui).toMatch(/emergency_contact_name: emName\.trim\(\)/);
    expect(ui).toMatch(/emergency_contact_phone: emPhone\.trim\(\)/);
  });
  it('форма регистрации маршрута подставляет контакт из профиля, не затирая введённое', () => {
    const reg = read('app/register/page.tsx');
    expect(reg).toMatch(/fetch\('\/api\/tourist\/profile'/);
    expect(reg).toMatch(/setEmergencyName\(\(v\) => v \|\| name\)/);
    expect(reg).toMatch(/setEmergencyPhone\(\(v\) => v \|\| phone\)/);
  });
});
