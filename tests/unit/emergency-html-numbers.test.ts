/**
 * Анти-дрейф статического аварийного «спасшлюпа» public/emergency.html.
 *
 * /emergency отдаёт этот статический HTML (app/emergency/route.ts) — слой, что
 * переживает падение всего JS/Next и работает офлайн из precache. Файл правится
 * руками, поэтому его номера могут молча разойтись с единым источником
 * lib/safety/emergency-numbers.ts (112-first + проверенные владельцем МЧС
 * Камчатки). Показать НЕВЕРНЫЙ номер в ЧП опаснее, чем не показать: этот тест
 * не даёт критическим номерам исчезнуть или разъехаться с каноном.
 *
 * Проверяем безопасное ядро: 112 (единый) + все VERIFIED_REGIONAL. Полный набор
 * федеральных (101/102/103) в статике курируется отдельно и здесь не форсится.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { EMERGENCY_PRIMARY, VERIFIED_REGIONAL, telHref } from '@/lib/safety/emergency-numbers';

const html = readFileSync(join(process.cwd(), 'public/emergency.html'), 'utf-8');

describe('public/emergency.html — анти-дрейф критических номеров', () => {
  it('содержит единый номер 112 как tel: (телефон и tap-to-call)', () => {
    expect(EMERGENCY_PRIMARY.phone).toBe('112'); // канон 112-first не сдвинулся
    expect(html).toContain(telHref(EMERGENCY_PRIMARY.phone)); // tel:112
    expect(html).toMatch(/(?<!\d)112(?!\d)/); // виден как отдельное число
  });

  it('содержит все проверенные номера МЧС Камчатки (tel:)', () => {
    for (const n of VERIFIED_REGIONAL) {
      expect(html, `нет ${n.phone} (${n.name}) в emergency.html`).toContain(telHref(n.phone));
    }
  });

  it('в наборе есть хотя бы один региональный МЧС-контакт (страховка от пустого VERIFIED_REGIONAL)', () => {
    expect(VERIFIED_REGIONAL.length).toBeGreaterThan(0);
  });
});
