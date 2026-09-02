// @vitest-environment node
/**
 * Экраны трансферов (схема 926, 02.09): витрина /transfers и кабинет /hub/carrier.
 *
 *   1. Витрина различает три исхода поиска: «ещё не искали», «искали — никто
 *      не едет», «не смогли проверить». Пустой список без searched: true не
 *      выдаётся за «мест нет» (урок удалённого transfer-empty-state, 02.08).
 *   2. Оплата места — общий SbpQrPayment со своими адресами; второго
 *      компонента QR нет. Свой SOS экраны не рисуют (#887).
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

const VITRINA = strip(read('app/transfers/_TransfersClient.tsx'));
const CABINET = strip(read('app/hub/carrier/_CarrierClient.tsx'));
const CABINET_LAYOUT = strip(read('app/hub/carrier/layout.tsx'));
const QR = strip(read('components/marketplace/SbpQrPayment.tsx'));

describe('1. витрина — три исхода поиска', () => {
  it('состояния названы и не сливаются', () => {
    for (const s of ["state: 'idle'", "state: 'loading'", "state: 'ok'", "state: 'failed'"]) expect(VITRINA).toContain(s);
  });
  it('успех требует searched: true от API, иначе — «не смогли проверить»', () => {
    expect(VITRINA).toMatch(/body\.searched !== true/);
    expect(VITRINA).toMatch(/Не смогли проверить поездки/);
    expect(VITRINA).toMatch(/Это не значит, что мест нет/);
  });
  it('ноль результатов сказан словами, а не пустотой', () => {
    expect(VITRINA).toMatch(/никто не едет/);
    expect(VITRINA).toMatch(/Попробуйте другие даты/);
  });
  it('запрос мест — за входом, гость видит дорогу ко входу', () => {
    expect(VITRINA).toMatch(/\/auth\/login\?from=\/transfers/);
    expect(VITRINA).toMatch(/Запрос ничего не держит/);
  });
});

describe('2. оплата и SOS', () => {
  it('оплата места — общий SbpQrPayment с адресами заказа мест', () => {
    expect(VITRINA).toMatch(/<SbpQrPayment\b/);
    expect(VITRINA).toMatch(/\/api\/carrier-trips\/bookings\/\$\{b\.id\}\/qr/);
    expect(QR).toMatch(/api\?\.issue/);
    expect(QR).toMatch(/api\?\.status/);
    // Второго компонента QR нет: ищем по назначению — img с QR СБП.
    expect(VITRINA).not.toMatch(/data:image\/png;base64/);
  });
  it('витрина несёт общий EmergencyAction и таб-бар, кабинет — под HubLayout', () => {
    expect(VITRINA).toMatch(/<EmergencyAction\b/);
    expect(VITRINA).toMatch(/<BottomNav\b/);
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
    for (const src of [VITRINA, CABINET]) {
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
