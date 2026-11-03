/**
 * Вход через MAX/Telegram ведёт в кабинет полной загрузкой (03.11).
 *
 * router.push после входа через мессенджер оставлял AuthContext с user=null,
 * и HubLayout возвращал на /auth/login — гид видел форму входа снова, хотя
 * сессия уже выдана. Сторож: оба обработчика уходят через
 * window.location.assign в кабинет своей роли (ROLE_HUB), без router.push.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'app/auth/login/_AuthPageClient.tsx'), 'utf-8');

function body(name: string): string {
  const start = src.indexOf(`const ${name} =`);
  expect(start, name).toBeGreaterThan(-1);
  const next = src.indexOf('\n  const ', start + 10);
  const end = src.indexOf('\n  return (', start);
  return src.slice(start, Math.min(next > 0 ? next : Infinity, end > 0 ? end : Infinity));
}

describe('вход через мессенджер — полная загрузка в кабинет роли', () => {
  it.each(['handleMaxAuth', 'handleTelegramAuth'])('%s не делает router.push и зовёт goToCabinet(role)', (name) => {
    const b = body(name);
    expect(b).not.toMatch(/router\.(push|replace)/);
    expect(b).toMatch(/goToCabinet\(/);
  });

  it('goToCabinet — window.location.assign в ROLE_HUB[role]', () => {
    const b = body('goToCabinet');
    expect(b).toMatch(/window\.location\.assign\(/);
    expect(b).toMatch(/ROLE_HUB\[role\]/);
    expect(b).not.toMatch(/router\./);
  });
});
