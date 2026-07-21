/**
 * Предохранитель руки действия эволюции: авто-применяется ТОЛЬКО
 * детерминированное. Эти тесты фиксируют, что превращается в правку, а что —
 * нет, и что защищённые пути и битые payload'ы не проходят.
 */
import { describe, it, expect } from 'vitest';
import { deterministicFix, parseFixPayload, isProtectedPath } from '@/lib/agents/evo/deterministic-fix';

describe('deterministicFix — что становится авто-правкой', () => {
  it('находка «Нет индекса: table.column» → add_index', () => {
    const fix = deterministicFix({
      category: 'performance',
      title: 'Нет индекса: operator_bookings.created_at',
      file_path: 'migrations/',
    });
    expect(fix).toEqual({ kind: 'add_index', table: 'operator_bookings', column: 'created_at' });
  });

  it('мёртвый файл (dead_code) → delete_file', () => {
    const fix = deterministicFix({
      category: 'dead_code',
      title: 'Мёртвый модуль: foo.ts',
      file_path: 'lib/agents/foo.ts',
    });
    expect(fix).toEqual({ kind: 'delete_file', path: 'lib/agents/foo.ts' });
  });

  it('dead_code в защищённом пути (auth) → null, не трогаем', () => {
    expect(deterministicFix({
      category: 'dead_code', title: 'x', file_path: 'lib/auth/jwt.ts',
    })).toBeNull();
  });

  it('произвольный баг/security → null (только текстовое предложение человеку)', () => {
    expect(deterministicFix({
      category: 'bug', title: 'SQL-инъекция в фильтре', file_path: 'app/api/x/route.ts',
    })).toBeNull();
    expect(deterministicFix({
      category: 'security', title: 'route без requireAuth', file_path: 'app/api/y/route.ts',
    })).toBeNull();
  });

  it('performance без распознаваемого заголовка индекса → null', () => {
    expect(deterministicFix({
      category: 'performance', title: 'Медленный запрос в дашборде', file_path: null,
    })).toBeNull();
  });
});

describe('parseFixPayload — что раннер согласен применить', () => {
  it('валидный add_index JSON', () => {
    expect(parseFixPayload('{"kind":"add_index","table":"agent_memory","column":"agent_id"}'))
      .toEqual({ kind: 'add_index', table: 'agent_memory', column: 'agent_id' });
  });

  it('валидный delete_file JSON', () => {
    expect(parseFixPayload('{"kind":"delete_file","path":"lib/dead.ts"}'))
      .toEqual({ kind: 'delete_file', path: 'lib/dead.ts' });
  });

  it('старый сырой AI-дифф (не JSON) → null, раннер игнорирует', () => {
    expect(parseFixPayload('--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-x\n+y')).toBeNull();
  });

  it('SQL-инъекция в имени таблицы/колонки отбивается регуляркой идентификатора', () => {
    expect(parseFixPayload('{"kind":"add_index","table":"t; DROP TABLE users;--","column":"c"}')).toBeNull();
    expect(parseFixPayload('{"kind":"add_index","table":"t","column":"c) ; DROP"}')).toBeNull();
  });

  it('delete_file защищённого пути → null', () => {
    expect(parseFixPayload('{"kind":"delete_file","path":"app/api/payments/x.ts"}')).toBeNull();
  });

  it('null/пустое → null', () => {
    expect(parseFixPayload(null)).toBeNull();
    expect(parseFixPayload('')).toBeNull();
  });
});

describe('isProtectedPath', () => {
  it('null путь считается защищённым (не трогаем)', () => {
    expect(isProtectedPath(null)).toBe(true);
  });
  it('auth/payments/webhook/sos/middleware/.env — защищены', () => {
    for (const p of ['lib/auth/x.ts', 'lib/payments/y.ts', 'app/api/webhook/z.ts',
      'app/api/payments/w.ts', 'app/api/safety/sos/route.ts', 'middleware.ts', 'config/.env']) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });
  it('обычный lib-файл не защищён', () => {
    expect(isProtectedPath('lib/agents/foo.ts')).toBe(false);
  });
});
