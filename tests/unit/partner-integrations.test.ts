/**
 * Ключи интеграций партнёров (Tilda API) — решение владельца 06.08:
 * «я не хочу в переменные добавлять ключи партнёра, он же будет не один —
 * давай добавим в Партнёра». Ключи живут в partner_integrations у записи
 * партнёра, не в env и не в коде (репозиторий публичный).
 *
 * Три инварианта:
 *  1. Секрет не покидает админский контур: таблицу с ключами читает только
 *     админ-API и lib/integrations — витрина и публичные роуты её не знают.
 *  2. Секрет наружу — только маской, даже админу и даже сразу после записи.
 *  3. Отказы Tilda читаются текстом до разбора JSON (урок MAX: не-JSON ответ
 *     не должен прятать причину).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { maskKey } from '@/lib/integrations/tilda';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

describe('маскировка ключей', () => {
  it('наружу уходит только хвост', () => {
    expect(maskKey('zr00000000000000f1a2')).toBe('····f1a2');
    expect(maskKey('abc')).toBe('····');
    expect(maskKey('')).toBe('····');
  });

  it('маска не раскрывает длину и начало ключа', () => {
    const m = maskKey('a'.repeat(40));
    expect(m).toHaveLength(8);
    expect(m).not.toContain('a'.repeat(5));
  });
});

describe('секрет не покидает админский контур', () => {
  it('partner_integrations читают только админ-роуты, lib/integrations и миграция', () => {
    const files = [...walk('app'), ...walk('lib'), ...walk('components')];
    const offenders = files.filter((f) => {
      if (f.startsWith(join('app', 'api', 'admin'))) return false;
      if (f.startsWith(join('lib', 'integrations'))) return false;
      return read(f).includes('partner_integrations');
    });
    expect(offenders, `partner_integrations утекла за админский контур: ${offenders.join(', ')}`).toEqual([]);
  });

  it('роут интеграции не возвращает секрет — только configured и маски', () => {
    const src = read('app/api/admin/operators/[id]/integrations/tilda/route.ts');
    // Каждый обработчик за requireAdmin.
    expect(src.match(/requireAdmin/g)?.length).toBeGreaterThanOrEqual(3);
    // В ответах нет сырых ключей: secret_key фигурирует только как _masked
    // или как поле разобранного ввода — но не в NextResponse без maskKey.
    for (const m of src.matchAll(/NextResponse\.json\(\{([^}]*)\}/g)) {
      const body = m[1];
      if (/secret_key|public_key/.test(body)) {
        expect(body, 'ключ в ответе без маски').toMatch(/_masked/);
        expect(body).not.toMatch(/secret_key:\s*(?!.*maskKey)/);
      }
    }
    expect(src).toMatch(/maskKey\(/);
  });

  it('в UI-панели секрет вводится type=password и не читается обратно', () => {
    const src = read('components/admin/TildaPanel.tsx');
    expect(src).toMatch(/type="password"/);
    // После сохранения поля очищаются — ключ не остаётся в состоянии клиента.
    expect(src).toMatch(/setSecretKey\(''\)/);
  });

  it('панель ОДНА и стоит в обоих админ-экранах партнёров', () => {
    // Владелец открыл «Управление партнёрами», а панель была только в
    // «Операторах» (06.08). Обе админки обязаны использовать общий компонент —
    // расходящиеся копии одного блока платформа уже проходила (#887).
    for (const screen of [
      'app/hub/admin/operators/_OperatorsClient.tsx',
      'app/hub/admin/content/partners/page.tsx',
    ]) {
      const src = read(screen);
      expect(src, `${screen} без общей панели Tilda`).toMatch(/from '@\/components\/admin\/TildaPanel'/);
      expect(src, `${screen} держит свою копию панели`).not.toMatch(/function TildaPanel/);
    }
  });

  it('строка партнёра открывается целиком, а не только карандашом за краем экрана', () => {
    const src = read('app/hub/admin/content/partners/page.tsx');
    expect(src).toMatch(/onRowClick=\{\(p\) => openEdit\(p\.id\)\}/);
  });
});

describe('живой вызов Tilda', () => {
  it('ответ читается текстом до разбора — не-JSON не прячет причину', () => {
    const src = read('lib/integrations/tilda.ts');
    const textAt = src.indexOf('res.text()');
    const parseAt = src.indexOf('JSON.parse');
    expect(textAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(textAt - 1);
  });

  it('ключи берутся из partner_integrations, в коде ключей нет', () => {
    const src = read('lib/integrations/tilda.ts');
    expect(src).toMatch(/FROM partner_integrations/);
    // Ни одного литерала, похожего на настоящий ключ (длинная hex/буквенно-
    // цифровая строка в кавычках) — ключи вносит админ через панель.
    const literals = src.match(/'[a-z0-9]{16,}'|"[a-z0-9]{16,}"/g) ?? [];
    expect(literals, `подозрительные литералы-ключи: ${literals.join(', ')}`).toEqual([]);
  });

  it('миграция 831 идемпотентна и с каскадом от партнёра', () => {
    const sql = read('migrations/831_partner_integrations.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS partner_integrations/);
    expect(sql).toMatch(/REFERENCES partners\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/UNIQUE \(partner_id, provider\)/);
    // Самих ключей в миграции нет и быть не может.
    expect(sql).not.toMatch(/[a-z0-9]{20}/);
  });
});
