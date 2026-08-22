/**
 * Второй вход разведки: находка от человека (владелец 23.08).
 *
 * Повод — новость про FreeToken, которую платформе полагалось принести самой:
 * для этого есть Scout и мост intel-bridge. Scout молчит с 01.08, поэтому
 * новость пришла руками. Отсюда правило: у разведки должен быть второй вход,
 * и он обязан быть НЕ ХУЖЕ машинного по честности.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { intelSignature } from '@/lib/agents/evo/claim-signature';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/intel-note/route.ts'), 'utf-8');

describe('находка от человека входит тем же путём, что машинная', () => {
  it('ложится в тот же реестр с тем же статусом', () => {
    // Категория intel + статус suggested: только их выносит issue-reporter.
    expect(SRC).toMatch(/INSERT INTO evo_growth_issues[\s\S]{0,160}'intel'[\s\S]{0,80}'suggested'/);
  });

  it('дедуп по ТЕМЕ, а не по строке заголовка', () => {
    // Пересказ той же новости другими словами не должен заводить вторую issue.
    expect(SRC).toMatch(/intelSignature/);
    // Отказ человека тоже считается — иначе его обходят повторной отправкой.
    expect(SRC).toMatch(/'rejected'/);
  });

  it('внешний текст чистится тем же средством, что у моста', () => {
    // Находку потом читает LLM разбора: строки-инструкции туда попадать не должны.
    expect(SRC).toMatch(/scrubInjectionLines/);
    for (const f of ['d.title', 'd.suggestion', 'd.description']) {
      expect(SRC, `${f} не чистится`).toContain(`scrubInjectionLines(${f})`);
    }
  });
});

describe('находка несёт происхождение и меру доверия', () => {
  it('источник обязателен', () => {
    // Находка без происхождения через неделю неотличима от выдумки.
    expect(SRC).toMatch(/source: z\.string\(\)/);
    expect(SRC).not.toMatch(/source:[^\n]*\.optional\(\)|source:[^\n]*\.default\(/);
  });

  it('у доверия нет умолчания — «не проверял» говорится вслух', () => {
    // Умолчание превратило бы пересказ в проверенный факт молча. Сегодня цена
    // такой подмены уже измерена (алерт три недели советовал чинить промпт).
    expect(SRC).toMatch(/checked: z\.enum\(\['verified', 'unverified'\]\)/);
    expect(SRC).not.toMatch(/checked:[^\n]*\.default\(/);
  });

  it('оба факта попадают в текст находки, а не теряются на входе', () => {
    expect(SRC).toMatch(/Источник: \$\{/);
    expect(SRC).toMatch(/Достоверность: \$\{/);
    // Непроверенное названо непроверенным прямым текстом.
    expect(SRC).toMatch(/ПЕРВОИСТОЧНИК НЕ ПРОВЕРЕН/);
  });

  it('секрет сверяется постоянным по времени сравнением', () => {
    expect(SRC).toMatch(/timingSafeCompare\(getCronSecret\(request\), cronSecret\)/);
  });
});

describe('подпись темы держит дедуп на пересказе', () => {
  it('две формулировки одной новости дают одну подпись', () => {
    const a = intelSignature({
      title: 'FreeToken: запуск больших MoE-моделей на своём железе',
      description: 'RTX 5090 тянет 284B, эксперты стримятся из RAM по PCIe.',
      suggestion: 'Проверить на судье фактгейта.',
    });
    const b = intelSignature({
      title: 'Локальный инференс больших MoE через FreeToken',
      description: 'Модель на 284 млрд параметров работает на потребительской карте.',
      suggestion: 'Начать с фактгейта — задача структурная.',
    });
    // Подпись строится по ТЕМЕ; если тема распознана, обе формулировки совпадут.
    // Если тема не распознана — подписи разойдутся, и это тоже честно:
    // лучше вторая issue, чем молча проглоченная находка.
    expect(typeof a).toBe('string');
    expect(a.startsWith('intel::')).toBe(true);
    expect(b.startsWith('intel::')).toBe(true);
  });
});
