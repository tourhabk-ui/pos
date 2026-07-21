/**
 * Предохранитель руки действия эволюции: авто-применяется ТОЛЬКО
 * детерминированное из allowlist'а (add_index по фиксированным таблицам/
 * колонкам). Эти тесты фиксируют, что становится правкой, а что — нет,
 * и что вне-allowlist / битые / инъекционные payload'ы не проходят.
 */
import { describe, it, expect } from 'vitest';
import { deterministicFix, parseFixPayload } from '@/lib/agents/evo/deterministic-fix';

describe('deterministicFix — что становится авто-правкой', () => {
  it('находка «Нет индекса: <allowlist-таблица>.<allowlist-колонка>» → add_index', () => {
    expect(deterministicFix({
      category: 'performance',
      title: 'Нет индекса: operator_bookings.created_at',
      file_path: 'migrations/',
    })).toEqual({ kind: 'add_index', table: 'operator_bookings', column: 'created_at' });
  });

  it('таблица вне allowlist → null (даже при валидном заголовке)', () => {
    expect(deterministicFix({
      category: 'performance', title: 'Нет индекса: users.created_at', file_path: 'migrations/',
    })).toBeNull();
  });

  it('колонка вне allowlist → null', () => {
    expect(deterministicFix({
      category: 'performance', title: 'Нет индекса: operator_bookings.email', file_path: 'migrations/',
    })).toBeNull();
  });

  it('dead_code больше НЕ автоприменяется (удаление файла — не рука) → null', () => {
    expect(deterministicFix({
      category: 'dead_code', title: 'Мёртвый модуль: foo.ts', file_path: 'lib/agents/foo.ts',
    })).toBeNull();
  });

  it('произвольный баг/security → null (только текстовое предложение человеку)', () => {
    expect(deterministicFix({ category: 'bug', title: 'SQL-инъекция', file_path: 'app/api/x/route.ts' })).toBeNull();
    expect(deterministicFix({ category: 'security', title: 'route без requireAuth', file_path: 'app/api/y/route.ts' })).toBeNull();
  });

  it('performance без распознаваемого заголовка индекса → null', () => {
    expect(deterministicFix({ category: 'performance', title: 'Медленный дашборд', file_path: null })).toBeNull();
  });
});

describe('parseFixPayload — что раннер согласен применить', () => {
  it('валидный add_index из allowlist', () => {
    expect(parseFixPayload('{"kind":"add_index","table":"agent_memory","column":"agent_id"}'))
      .toEqual({ kind: 'add_index', table: 'agent_memory', column: 'agent_id' });
  });

  it('add_index вне allowlist → null', () => {
    expect(parseFixPayload('{"kind":"add_index","table":"users","column":"created_at"}')).toBeNull();
    expect(parseFixPayload('{"kind":"add_index","table":"operator_bookings","column":"password"}')).toBeNull();
  });

  it('старый delete_file больше не принимается → null', () => {
    expect(parseFixPayload('{"kind":"delete_file","path":"lib/dead.ts"}')).toBeNull();
  });

  it('старый сырой AI-дифф (не JSON) → null', () => {
    expect(parseFixPayload('--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-x\n+y')).toBeNull();
  });

  it('инъекция в имя таблицы/колонки не проходит allowlist → null', () => {
    expect(parseFixPayload('{"kind":"add_index","table":"operator_bookings; DROP TABLE users;--","column":"created_at"}')).toBeNull();
    expect(parseFixPayload('{"kind":"add_index","table":"operator_bookings","column":"created_at) ; DROP"}')).toBeNull();
  });

  it('null/пустое → null', () => {
    expect(parseFixPayload(null)).toBeNull();
    expect(parseFixPayload('')).toBeNull();
  });
});
