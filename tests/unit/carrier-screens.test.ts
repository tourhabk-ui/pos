// @vitest-environment node
/**
 * Экраны трансферов (схема 926, 02.09): витрина /transfers и кабинет /hub/carrier.
 *
 *   1. Витрины мест больше нет (владелец 13.10: «бронируют целую машину а не
 *      место в ней»); /transfers судит рендер — tests/unit/transfers-page.
 *   2. Оплата места — общий SbpQrPayment со своими адресами; второго
 *      компонента QR нет (компонент — общий, адреса мест спят вместе с
 *      модулем). Свой SOS кабинет не рисует (#887).
 *   3. Роль перевозчика ведёт в живой кабинет: /hub/carrier существует,
 *      требует роль transfer, а мёртвый /hub/transfer-operator нигде не
 *      назначением.
 *   4. Экраны не ходят в таблицы напрямую — только через /api.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_HUB } from '@/lib/auth/role-routes';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const CABINET = strip(read('app/hub/carrier/_CarrierClient.tsx'));
const CABINET_LAYOUT = strip(read('app/hub/carrier/layout.tsx'));
const QR = strip(read('components/marketplace/SbpQrPayment.tsx'));

// 1. Витрины мест нет (13.10); /transfers судит рендер — transfers-page.

describe('2. оплата и SOS', () => {
  it('QR СБП — один общий компонент, адреса ему передаёт экран', () => {
    expect(QR).toMatch(/api\?\.issue/);
    expect(QR).toMatch(/api\?\.status/);
  });
  it('кабинет — под HubLayout (SOS там общий, своей копии нет)', () => {
    expect(CABINET_LAYOUT).toMatch(/<HubLayout\b/);
  });
});

describe('3. роль перевозчика', () => {
  it('ROLE_HUB ведёт в существующий кабинет', () => {
    expect(ROLE_HUB.transfer).toBe('/hub/carrier');
    expect(ROLE_HUB.transfer_operator).toBe('/hub/carrier');
    expect(existsSync(join(ROOT, 'app/hub/carrier/page.tsx'))).toBe(true);
  });
  it('кабинет требует роль transfer', () => {
    expect(CABINET_LAYOUT).toMatch(/requiredRole=\{\['transfer', 'transfer_operator', 'admin'\]\}/);
  });
  it('мёртвый /hub/transfer-operator нигде не назначение', () => {
    for (const f of ['lib/auth/role-routes.ts', 'app/api/roles/route.ts', 'app/profile/_ProfilePageClient.tsx']) {
      expect(strip(read(f)), `${f} снова ведёт на удалённый кабинет`).not.toMatch(/\/hub\/transfer-operator/);
    }
  });
});

describe('4. экраны ходят только в /api', () => {
  it('ни SQL, ни таблиц трансферов в клиентах', () => {
    for (const src of [CABINET]) {
      expect(src).not.toMatch(/FROM transfer_|INSERT INTO|UPDATE transfer_|db-pool|@\/lib\/database/);
    }
  });
  it('кабинет пишет только через /api/hub/carrier', () => {
    // Литеральные адреса fetch; `fetch(url, …)` в load() — параметр, его
    // адреса перечислены в reloadAll теми же литералами.
    const writes = [...CABINET.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)].map(m => m[1]);
    const reads = [...CABINET.matchAll(/load<\w+>\(\s*'([^']+)'/g)].map(m => m[1]);
    expect(writes.length + reads.length).toBeGreaterThanOrEqual(6);
    for (const w of [...writes, ...reads]) expect(w.startsWith('/api/hub/carrier'), `посторонний адрес ${w}`).toBe(true);
    for (const w of writes) expect(w.startsWith('/api/hub/carrier'), `посторонний адрес ${w}`).toBe(true);
  });
  it('исходы кабинета — три: загружаем / есть / не смогли прочитать', () => {
    expect(CABINET).toMatch(/Не смогли прочитать/);
    expect(CABINET).toMatch(/Это не значит, что их нет/);
  });
});
