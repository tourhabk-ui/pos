/**
 * Страж достоверности находок Growth Scan. Фикстуры «reject» — ДОСЛОВНЫЕ
 * галлюцинации из ночных прогонов (run #255, #258). Фикстуры «pass» — реальные
 * находки, которые страж НЕ должен глушить.
 */
import { describe, it, expect } from 'vitest';
import { findingRejectionReason, isCredibleFinding } from '@/lib/agents/evo/finding-guard';

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
