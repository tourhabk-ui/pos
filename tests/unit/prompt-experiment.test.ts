/**
 * Инструменты для проверки ходового совета «умной модели длинные инструкции
 * мешают, режь промпт».
 *
 * Совет может быть верен, а может не переноситься на наши задачи — узнать это
 * можно только замером. Но замер легко подстроить под желаемое: регрессия
 * Editor меряет успех как «текст не короче 300 символов», и по этой метрике
 * короткий промпт выигрывает ЗАВЕДОМО — без запретов модель пишет охотнее и
 * длиннее. Мы бы сами себе доказали улучшение ровно там, где качество упало.
 *
 * Поэтому у эксперимента два оракула, и правило сравнения консервативное:
 * рост TSR при росте выдумок улучшением не считается.
 */
import { describe, it, expect } from 'vitest';
import { detectFabrication, extractNumericClaims } from '@/lib/agents/eval/fabrication';
import { compareVariants, type RegressionReport } from '@/lib/agents/eval/editor-regression';
import {
  analyzePrompt,
  extractPromptLiterals,
  MAX_PROHIBITIONS,
} from '@/lib/agents/eval/prompt-bloat';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('оракул выдумок: числа, которых не было во входе', () => {
  it('высота, взятая из головы, — выдумка', () => {
    const r = detectFabrication('Вулкан высотой 2741 м виден издалека.', 'Авачинский вулкан');
    expect(r.hasFabrication).toBe(true);
    expect(r.invented).toContain('2741');
  });

  it('число, пришедшее из входных данных, выдумкой не считается', () => {
    const r = detectFabrication('Высота 2741 м.', 'Авачинский вулкан, высота 2741 м');
    expect(r.hasFabrication).toBe(false);
  });

  it('десятичная запятая и точка — одно и то же число', () => {
    const r = detectFabrication('Маршрут 12,5 км.', 'Тропа длиной 12.5 км');
    expect(r.hasFabrication).toBe(false);
  });

  it('«два-три дня» и годы за измерение не принимаются', () => {
    expect(detectFabrication('Поход занимает 2 дня.', 'Тропа').hasFabrication).toBe(false);
    expect(detectFabrication('Извержение 1945 года.', 'Вулкан').hasFabrication).toBe(false);
  });

  it('температура источника без источника данных — выдумка', () => {
    const r = detectFabrication('Вода в источнике около 45 °C.', 'Горячий источник');
    expect(r.invented).toContain('45');
  });

  it('число в измерительном контексте ловится и без единицы', () => {
    expect(extractNumericClaims('Перепад высот составляет 900.')).toContain('900');
  });

  it('честное обобщение без цифр — чисто', () => {
    const text = 'Место с суровым характером; точные параметры уточняйте у оператора и в дирекции парка.';
    expect(detectFabrication(text, 'Некое место').hasFabrication).toBe(false);
  });
});

describe('сравнение вариантов: нельзя доказать себе желаемое', () => {
  function report(over: Partial<RegressionReport>): RegressionReport {
    return {
      total: 12, passed: 9, tsr: 0.75, ci: { low: 0.5, high: 0.9 },
      goal_min: 300, cases: [], fabrication_rate: 0.1, invented_total: 2, ...over,
    };
  }

  it('рост TSR при росте выдумок — не улучшение', () => {
    const a = report({ tsr: 0.6, ci: { low: 0.4, high: 0.75 }, fabrication_rate: 0.1 });
    const b = report({ tsr: 0.95, ci: { low: 0.8, high: 0.99 }, fabrication_rate: 0.4 });
    const v = compareVariants(a, b);
    expect(v.verdict).toContain('выдумывает чаще');
    expect(v.fabrication_delta).toBeGreaterThan(0);
  });

  it('пересечение интервалов — разница не доказана', () => {
    const a = report({ tsr: 0.75, ci: { low: 0.5, high: 0.9 } });
    const b = report({ tsr: 0.83, ci: { low: 0.6, high: 0.95 } });
    expect(compareVariants(a, b).tsr_inconclusive).toBe(true);
    expect(compareVariants(a, b).verdict).toContain('не доказана');
  });

  it('выигрыш по TSR без роста выдумок — принимается', () => {
    const a = report({ tsr: 0.5, ci: { low: 0.3, high: 0.65 }, fabrication_rate: 0.2 });
    const b = report({ tsr: 0.95, ci: { low: 0.8, high: 0.99 }, fabrication_rate: 0.1 });
    expect(compareVariants(a, b).verdict).toContain('можно принимать');
  });

  it('падение TSR — вариант отклоняется', () => {
    const a = report({ tsr: 0.9, ci: { low: 0.8, high: 0.97 }, fabrication_rate: 0.1 });
    const b = report({ tsr: 0.4, ci: { low: 0.2, high: 0.6 }, fabrication_rate: 0.1 });
    expect(compareVariants(a, b).verdict).toContain('оставить A');
  });
});

/**
 * §8 CLAUDE.md запрещает наращивать в промптах перечни кейсов, но это правило
 * о правилах — до сих пор его никто не проверял.
 */
describe('сторож разрастания промптов', () => {
  it('принципиальный промпт проходит', () => {
    const good = [
      'Ты помощник по Камчатке. Главная цель — безопасность туриста.',
      'Факты о безопасности бери только из инструментов.',
      'Пиши спокойно и по делу.',
    ].join('\n');
    expect(analyzePrompt('GOOD', good).bloated).toBe(false);
  });

  it('свалка исключений не проходит', () => {
    const bloated = Array.from({ length: MAX_PROHIBITIONS + 3 }, (_, i) =>
      `- НИКОГДА не делай случай ${i}, кроме ситуации ${i}`).join('\n');
    const r = analyzePrompt('BLOATED', bloated);
    expect(r.bloated).toBe(true);
    expect(r.reason).toContain('инструмент');
  });

  it('живые промпты Кузьмича и Editor укладываются в порог', () => {
    const files = ['lib/kuzmich/core.ts', 'lib/agents/editor.ts'];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf-8');
      for (const { name, text } of extractPromptLiterals(source)) {
        const r = analyzePrompt(name, text);
        expect(r.bloated, `${file} → ${name}: ${r.reason ?? ''}`).toBe(false);
      }
    }
  });
});
