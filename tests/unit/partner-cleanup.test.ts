/**
 * Уборка бесхозных партнёров: необратимое действие с четырьмя тормозами.
 *
 * Решение владельца 22.08.2026 по цифрам переписи: из 128 партнёров два имеют
 * туры, 116 держатся аттестациями или входом в кабинет, десять не привязаны
 * ни к чему. Удаляются только десять.
 *
 * Почему роут, а не миграция: на `partners` 39 внешних ключей из 25 таблиц.
 * Миграция идёт одной транзакцией — одна упёршаяся строка откатила бы весь
 * файл, а файл записался бы применённым (задача #58). Именно этот дефект
 * сегодня скрыл пропажу комиссии платформы; повторять его в необратимой
 * операции нельзя.
 *
 * Сторож держит все четыре тормоза. Каждый из них — ответ на то, что уже
 * случалось: молчаливое согласие, каскад, потеря причины отказа, слепое
 * доверие выборке.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/partner-cleanup/route.ts'), 'utf-8');

describe('доступ', () => {
  it('закрыт CRON_SECRET со сравнением за постоянное время', () => {
    expect(SRC).toMatch(/getCronSecret\(request\)/);
    expect(SRC).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });
});

describe('тормоза', () => {
  it('по умолчанию НИЧЕГО не удаляет — нужен явный confirm', () => {
    expect(SRC).toMatch(/confirm = body\?\.confirm === true/);
    expect(SRC).toMatch(/dry_run: true/);
  });

  it('отсутствие тела — сухой прогон, а не ошибка и не удаление', () => {
    const catchBlock = SRC.slice(SRC.indexOf('} catch {'), SRC.indexOf('try {', SRC.indexOf('} catch {')));
    expect(catchBlock).not.toMatch(/confirm = true/);
  });

  it('есть потолок, и превышение — отказ ЦЕЛИКОМ', () => {
    // «Удалили сколько смогли» здесь худший исход: столько бесхозных сразу
    // означает сломанный подсчёт связей, а не появившийся мусор.
    expect(SRC).toMatch(/MAX_DELETE\s*=\s*\d+/);
    expect(SRC).toMatch(/candidates\.length > MAX_DELETE/);
    expect(SRC).toMatch(/status: 409/);
  });

  it('каждая строка удаляется в своей транзакции', () => {
    // Иначе одна упёршаяся в ключ отменяет всю уборку.
    expect(SRC).toMatch(/for \(const c of candidates\)/);
    expect(SRC).toMatch(/BEGIN/);
    expect(SRC).toMatch(/COMMIT/);
    expect(SRC).toMatch(/ROLLBACK/);
    expect(SRC).toMatch(/client\.release\(\)/);
  });
});

describe('что именно удаляется', () => {
  it('условия связи повторены в самом DELETE, а не только в выборке', () => {
    // Между выборкой и удалением партнёр мог обзавестись туром или кабинетом.
    const del = SRC.slice(SRC.indexOf('DELETE FROM partners'));
    expect(del).toMatch(/user_id IS NULL/);
    expect(del).toMatch(/operator_tours/);
    expect(del).toMatch(/guide_certifications/);
  });

  it('аттестованный гид не может быть удалён', () => {
    // 112 записей — собранные данные; каскад снёс бы их молча.
    const del = SRC.slice(SRC.indexOf('DELETE FROM partners'));
    expect(del).toMatch(/NOT EXISTS \(SELECT 1 FROM guide_certifications/);
  });
});

describe('отчёт', () => {
  it('отказ строки называет причину и ограничение', () => {
    // «Пропущено» без причины — то же молчание, что и пустой catch.
    expect(SRC).toMatch(/e\?\.constraint/);
    expect(SRC).toMatch(/skipped/);
  });

  it('третий исход: не смог — это не «удалять было нечего»', () => {
    expect(SRC).toMatch(/ok: false/);
    expect(SRC).toMatch(/console\.error/);
  });
});
