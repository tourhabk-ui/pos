/**
 * Страж достоверности находок Growth Scan. Фикстуры «reject» — ДОСЛОВНЫЕ
 * галлюцинации из ночных прогонов (run #255, #258). Фикстуры «pass» — реальные
 * находки, которые страж НЕ должен глушить.
 */
import { describe, it, expect } from 'vitest';
import { findingRejectionReason, isCredibleFinding, verifyAgainstSource } from '@/lib/agents/evo/finding-guard';

describe('finding-guard — режет галлюцинации ночных сканов', () => {
  it('callAIFast заклеймён нарушением (run #255) → reject', () => {
    expect(findingRejectionReason({
      title: 'Прямой вызов callAIFast',
      description: 'Используется прямой вызов callAIFast вместо callAIWaterfall, нарушая конвенцию проекта.',
      suggestion: 'Заменить import { callAIFast } на import { callAIWaterfall } и вызвать callAIWaterfall',
    })).toBe('sanctioned_callaifast');
  });

  it('«callAIWaterfall вместо callAIWaterfall» (run #258) → reject как бессмыслица', () => {
    expect(findingRejectionReason({
      title: 'Использование callAIWaterfall вместо callAIWaterfall',
      description: 'В комментарии указано использование callAIWaterfall, но в коде используется callAIWaterfall — нарушение конвенции проекта',
      suggestion: 'Заменить callAIWaterfall на callAIWaterfall в соответствии с конвенцией проекта',
    })).toBe('incoherent_same_token');
  });

  it('console.error заклеймён нарушением (run #258) → reject', () => {
    expect(findingRejectionReason({
      title: 'Прямой call console.error',
      description: 'Использование console.error() в функции saveBotMemory() нарушает конвенцию проекта, где должны использоваться логгеры',
      suggestion: 'Заменить console.error() на соответствующий логгер из проекта',
    })).toBe('sanctioned_console_error');
  });
});

describe('finding-guard — НЕ глушит реальные находки', () => {
  const real = [
    {
      title: 'SQL-инъекция в фильтре',
      description: 'Конкатенация строк вместо параметров $1,$2 в WHERE — инъекция при вводе кавычки',
      suggestion: 'Заменить конкатенацию на параметризованный $1',
    },
    {
      title: 'Route без requireAuth',
      description: 'Защищённый POST не вызывает requireAuth — обход авторизации',
      suggestion: 'Добавить requireAuth в начало обработчика',
    },
    {
      title: 'console.log в проде',
      description: 'Отладочный console.log в обработчике брони попадает в прод-логи',
      suggestion: 'Убрать console.log или заменить на console.error в catch',
    },
    {
      title: 'Прямой callDeepSeek',
      description: 'Прямой вызов callDeepSeek вместо callAIWaterfall в обход waterfall',
      suggestion: 'Заменить callDeepSeek на callAIWaterfall',
    },
    {
      title: 'callAIFast без try/catch',
      description: 'Внешний вызов callAIFast не обёрнут в try/catch — падение при сбое провайдера',
      suggestion: 'Обернуть вызов в try/catch',
    },
  ];

  it('все реальные находки проходят страж', () => {
    for (const f of real) {
      expect(isCredibleFinding(f), `ложно отклонена: ${f.title}`).toBe(true);
    }
  });

  it('callAIFast без конвенционного клейма (только try/catch) — проходит', () => {
    expect(findingRejectionReason({
      title: 'callAIFast без try/catch',
      description: 'Внешний вызов callAIFast не обёрнут в try/catch',
      suggestion: 'Добавить try/catch',
    })).toBeNull();
  });
});

describe('finding-guard — чужой стек (Prisma/NextAuth) = галлюцинация', () => {
  it('«оберни в Prisma-транзакцию» (booking-роут #738) → reject', () => {
    expect(findingRejectionReason({
      title: 'Race condition: concurrent booking creation',
      description: 'No locking prevents overselling. Two requests pass availability check.',
      suggestion: 'Обернуть проверку и создание в Prisma-транзакцию с SELECT ... FOR UPDATE',
    })).toBe('foreign_stack');
  });

  it('«добавь getServerSession» (booking-роут #737) → reject', () => {
    expect(findingRejectionReason({
      title: 'No authentication check visible',
      description: 'Route accepts requests without verifying identity.',
      suggestion: 'Получить сессию через getServerSession и вернуть 401 при отсутствии',
    })).toBe('foreign_stack');
  });
});

describe('finding-guard — верификационный проход по телу файла', () => {
  // Фрагмент booking-роута: JWT-auth + try/catch + FOR UPDATE (реальный код).
  const bookingSrc = `
    import { verifyToken, extractToken } from '@/lib/auth/jwt';
    export async function POST(req) {
      const token = extractToken(req);
      const authedUser = token ? await verifyToken(token) : null;
      try {
        const tour = await client.query('SELECT ... FOR UPDATE', [id]);
        return NextResponse.json({ ok: true });
      } catch (err) {
        return NextResponse.json({ error: 'fail' }, { status: 500 });
      }
    }`;

  it('«нет try/catch», а он есть → source_has_try_catch', () => {
    expect(verifyAgainstSource({
      title: 'Missing Error Handling',
      description: 'createBooking is not wrapped in a try/catch block, unhandled exception crashes server.',
      suggestion: 'Обернуть вызов в try/catch',
    }, bookingSrc)).toBe('source_has_try_catch');
  });

  it('«нет авторизации, userId из body», а JWT есть → source_has_auth', () => {
    expect(verifyAgainstSource({
      title: 'No authorization check',
      description: 'userId from request body is not validated against session. User can create bookings for others.',
      suggestion: 'Брать userId из проверенной сессии',
    }, bookingSrc)).toBe('source_has_auth');
  });

  it('«race condition без блокировки», а FOR UPDATE есть → source_has_lock', () => {
    expect(verifyAgainstSource({
      title: 'Race condition in concurrent booking',
      description: 'No pessimistic locking before INSERT, concurrent requests oversell slots.',
      suggestion: 'Добавить SELECT ... FOR UPDATE',
    }, bookingSrc)).toBe('source_has_lock');
  });

  it('реальная находка «нет try/catch» на файле БЕЗ него — НЕ отклоняется', () => {
    const noGuard = `export async function POST(req){ const b = await req.json(); return doThing(b); }`;
    expect(verifyAgainstSource({
      title: 'Missing try/catch',
      description: 'External call not wrapped in try/catch',
      suggestion: 'Add try/catch',
    }, noGuard)).toBeNull();
  });

  it('нет исходника → null (нечего сверять)', () => {
    expect(verifyAgainstSource({ title: 'x', description: 'no try/catch', suggestion: 'y' }, null)).toBeNull();
  });
});
