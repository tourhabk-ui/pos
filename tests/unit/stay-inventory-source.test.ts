/**
 * Класс источника фонда жилья (миграция 1302, lib/stay/inventory-source.ts):
 * фундамент собственной системы бронирования — своя БД vs канал поверх PMS.
 * Здесь сторожим словарь, наследие NULL и то, что миграция не меняет данные.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INVENTORY_SOURCES,
  PMS_VENDORS,
  CHANNEL_MANAGERS,
  isInventorySource,
  isPmsVendor,
  isChannelManager,
  resolveInventorySource,
  isExternalInventory,
} from '@/lib/stay/inventory-source';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const MIG = 'migrations/1302_accommodation_inventory_source.sql';

describe('словарь источника фонда', () => {
  it('ровно два класса: своя БД и внешняя PMS', () => {
    expect(INVENTORY_SOURCES).toEqual(['vedar_pms', 'external_pms']);
    expect(isInventorySource('vedar_pms')).toBe(true);
    expect(isInventorySource('external_pms')).toBe(true);
    expect(isInventorySource('travelline')).toBe(false);
    expect(isInventorySource(null)).toBe(false);
  });

  it('вендоры PMS и менеджеры каналов проверяются словарём', () => {
    expect(PMS_VENDORS).toContain('logus');
    expect(isPmsVendor('logus')).toBe(true);
    expect(isPmsVendor('opera')).toBe(false);
    expect(CHANNEL_MANAGERS).toContain('travelline');
    expect(isChannelManager('travelline')).toBe(true);
    expect(isChannelManager('logus')).toBe(false);
  });

  it('NULL и неизвестное — наследие vedar_pms, внешняя PMS только явно', () => {
    expect(resolveInventorySource(null)).toBe('vedar_pms');
    expect(resolveInventorySource(undefined)).toBe('vedar_pms');
    expect(resolveInventorySource('что-то')).toBe('vedar_pms');
    expect(resolveInventorySource('external_pms')).toBe('external_pms');
    expect(isExternalInventory(null)).toBe(false);
    expect(isExternalInventory('external_pms')).toBe(true);
  });
});

describe('миграция 1302', () => {
  it('колонки и CHECK совпадают со словарём модуля', () => {
    const sql = read(MIG);
    for (const v of INVENTORY_SOURCES) expect(sql).toContain(`'${v}'`);
    for (const v of PMS_VENDORS) expect(sql).toContain(`'${v}'`);
    for (const v of CHANNEL_MANAGERS) expect(sql).toContain(`'${v}'`);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS inventory_source TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS pms_vendor TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS channel_manager TEXT/);
  });

  it('данные не переписывает: ни UPDATE, ни backfill существующих строк', () => {
    const sql = read(MIG);
    expect(sql).not.toMatch(/^\s*UPDATE\s+accommodations\b/m);
    expect(sql).not.toMatch(/SET\s+inventory_source\s*=/);
  });
});
