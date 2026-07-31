/**
 * Петля знаний эволюции читается, а не только пишется.
 *
 * Находка 31.07: feedback-loop извлекал уроки из вердиктов человека
 * (evo_feedback.ai_learning) и вёл сводную стратегию
 * (evo_agent_state.learning_summary) — и НИ ОДИН модуль это не читал.
 * Grep по репозиторию: ноль потребителей. Система вела дневник, который
 * никто не открывал; сканер каждый прогон начинал с чистого листа и
 * повторял уже отвергнутые претензии.
 *
 * Сторож держит оба конца: чистые функции сборки блока — и сканы исходников,
 * чтобы чтение не отвалилось молча (как оно молча отсутствовало до сих пор).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRejectedDigest,
  lessonsPromptBlock,
  MAX_REJECTED_LINES,
  type LearnedLessons,
} from '@/lib/agents/evo/learned-lessons';

const EMPTY: LearnedLessons = { strategy: null, lessons: [], rejectedDigest: [] };

describe('buildRejectedDigest: сводка отказов по классу, не по формулировке', () => {
  it('перефразировки одного класса схлопываются со счётчиком', () => {
    const rows = [
      { file_path: 'app/api/x/route.ts', title: 'Отсутствует requireAuth' },
      { file_path: 'app/api/x/route.ts', title: 'Нет проверки авторизации' },
      { file_path: 'app/api/x/route.ts', title: 'Route не защищён middleware авторизации' },
      { file_path: 'lib/y.ts', title: 'Вызов не обёрнут в try/catch' },
    ];
    const digest = buildRejectedDigest(rows);
    expect(digest[0]).toBe('app/api/x/route.ts::missing_auth ×3');
    expect(digest).toContain('lib/y.ts::missing_try_catch');
  });

  it('сортировка по частоте, обрезка по лимиту', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      file_path: `f${i}.ts`, title: 'Нет try/catch',
    }));
    expect(buildRejectedDigest(rows)).toHaveLength(MAX_REJECTED_LINES);
  });

  it('пусто на входе — пусто на выходе', () => {
    expect(buildRejectedDigest([])).toEqual([]);
  });
});

describe('lessonsPromptBlock: компактный блок или ничего', () => {
  it('нечему учить — пустая строка, промпт не засоряется заглушкой', () => {
    expect(lessonsPromptBlock(EMPTY)).toBe('');
  });

  it('все три части попадают в блок', () => {
    const block = lessonsPromptBlock({
      strategy: '• success: для add_indexes проверять частичные индексы',
      lessons: ['Для фиксов bug — не предлагать Prisma'],
      rejectedDigest: ['app/api/x/route.ts::missing_auth ×3'],
    });
    expect(block).toContain('ВЫУЧЕНО НА ПРОШЛЫХ ВЕРДИКТАХ');
    expect(block).toContain('частичные индексы');
    expect(block).toContain('не предлагать Prisma');
    expect(block).toContain('missing_auth ×3');
  });

  it('потолок по символам соблюдается', () => {
    const block = lessonsPromptBlock({
      strategy: 'x'.repeat(5000),
      lessons: [],
      rejectedDigest: [],
    }, 500);
    expect(block.length).toBeLessThanOrEqual(500);
    expect(block.endsWith('…')).toBe(true);
  });

  it('пустая/пробельная стратегия не рождает блок сама по себе', () => {
    expect(lessonsPromptBlock({ strategy: '   ', lessons: [], rejectedDigest: [] })).toBe('');
  });
});

describe('петля знаний подключена в исходниках', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
  const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('growth-agent читает выученное перед ревью', () => {
    const src = code(read('lib/agents/evo/growth-agent.ts'));
    expect(src, 'сканер снова начинает с чистого листа — чтение уроков отвалилось')
      .toMatch(/loadLearnedLessons/);
    expect(src).toMatch(/lessonsPromptBlock/);
  });

  it('feedback-loop извлекает уроки решателем, а не захардкоженным gemini', () => {
    const src = code(read('lib/agents/evo/feedback-loop.ts'));
    // CLAUDE.md §8: gemini-2.0-flash «больше не используется для решений»,
    // model-id не хардкодить. Уроки — тоже решения.
    expect(src, 'вернулся хардкод слабой модели в извлечение уроков')
      .not.toMatch(/gemini-2\.0-flash/);
    expect(src).toMatch(/callAIDecision\(/);
  });

  it('intel-bridge отдаёт известные темы модели в промпт, а не только в дедуп', () => {
    const src = code(read('lib/agents/evo/intel-bridge.ts'));
    // Дедуп срезает повтор ПОСЛЕ ответа — слот из трёх уже потрачен.
    expect(src, 'известные темы больше не сообщаются модели заранее')
      .toMatch(/knownTopics/);
    expect(src).toMatch(/НЕ предлагай/);
  });
});
