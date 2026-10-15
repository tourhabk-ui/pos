/**
 * Грейдер Кузьмича: чистка ПД, хэш разговора и дневной потолок (аудит 15.10,
 * W2-5 и A20, решение (б)).
 *
 * До правки грейдер слал судье — зарубежной модели — сырой вопрос туриста
 * (300 знаков) и ответ, а в запись оценки клал сырой id чата. Оценивался
 * только Telegram и MAX; с веба исходов не было вовсе. Решение: оценивать все
 * содержательные ответы со всех поверхностей, но не больше 300 в сутки по
 * Камчатке.
 *
 * Сторож — вызовом настоящего gradeKuzmichResponse; подменены модель-судья и
 * база. Подменная база держит то же правило, что SQL места под оценку
 * («вставить, если за сутки меньше потолка»), — сам SQL проверен на настоящем
 * PostgreSQL 16 при правке (счёт, граница суток по Камчатке, замок).
 *  1. Судья видит [телефон] и [email], а не номер и почту; в записи их нет.
 *  2. В записи оценки нет сырого id чата — только хэш.
 *  3. Потолок: 300 оценок проходят, 301-я модель не зовёт и пишет в лог.
 *  4. Счёт не удался — оценка пропущена с логом, модель не зовётся.
 *  5. Отказ модели и короткий обрыв места под оценку не занимают.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { db, fast } = vi.hoisted(() => ({
  db: {
    /** Сколько строк журнала оценок за текущие сутки. */
    gradesToday: 0,
    /** Счёт падает — как недоступная таблица. */
    failCount: false,
    /** Параметры INSERT INTO agent_knowledge. */
    knowledge: [] as unknown[][],
    /** Порядок команд в транзакции места под оценку. */
    tx: [] as string[],
  },
  fast: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO agent_knowledge/.test(sql)) db.knowledge.push(params ?? []);
      return { rows: [], rowCount: 1 };
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        db.tx.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
        if (/INSERT INTO ai_actions_log/.test(sql)) {
          if (db.failCount) throw Object.assign(new Error('relation "ai_actions_log" does not exist'), { code: '42P01' });
          // То же правило, что у SQL: вставка — только пока за сутки меньше потолка.
          if (db.gradesToday < Number(params?.[1])) {
            db.gradesToday += 1;
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    })),
  },
}));
vi.mock('@/lib/ai/providers', () => ({ callAIFast: (...a: unknown[]) => fast(...a) }));

import { gradeKuzmichResponse, conversationTag, GRADER_DAILY_CAP } from '@/lib/agents/managed/kuzmich-outcomes';

const PHONE = '+7 914 123-45-67';
const EMAIL = 'ivan.petrov@mail.ru';
const CHAT_ID = 987654321;
const QUESTION = `Как добраться до Авачинского вулкана? Перезвоните ${PHONE} или ${EMAIL}`;
const ANSWER = 'До Авачинского вулкана — от Петропавловска по грунтовке на Авачинский перевал, '
  + `дальше пешком. Если что — пишите ${EMAIL}, звоните ${PHONE}.`;

/** Что увидел судья. */
function judgePrompt(call = 0): string {
  const msgs = fast.mock.calls[call]![0] as Array<{ content: string }>;
  return msgs.map((m) => m.content).join('\n');
}

let warn: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.gradesToday = 0;
  db.failCount = false;
  db.knowledge = [];
  db.tx = [];
  fast.mockReset();
  fast.mockResolvedValue('{"score": 4, "issues": ["нет статуса вулкана"]}');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  err.mockRestore();
});

describe('грейдер: ПД туриста не уходят судье и не ложатся в запись', () => {
  it('судья видит [телефон] и [email], а не номер и почту', async () => {
    await gradeKuzmichResponse(QUESTION, ANSWER, CHAT_ID, { surface: 'web' });
    expect(fast).toHaveBeenCalledTimes(1);
    const prompt = judgePrompt();
    expect(prompt).toContain('[телефон]');
    expect(prompt).toContain('[email]');
    expect(prompt).not.toContain(EMAIL);
    expect(prompt.replace(/\D/g, '')).not.toContain('9141234567');
  });

  it('в записи оценки нет ни телефона, ни почты, ни сырого id чата', async () => {
    await gradeKuzmichResponse(QUESTION, ANSWER, CHAT_ID, { surface: 'telegram' });
    expect(db.knowledge).toHaveLength(1);
    const [slug, , text, meta] = db.knowledge[0] as [string, string, string, string];
    expect(slug).not.toContain(String(CHAT_ID));
    expect(slug).toContain(conversationTag(CHAT_ID));
    expect(text).not.toContain(EMAIL);
    expect(text.replace(/\D/g, '')).not.toContain('9141234567');
    expect(JSON.parse(meta)).toMatchObject({ surface: 'telegram' });
  });

  it('хэш разговора: один ключ — один хэш, разные — разные, нет ключа — «nokey»', () => {
    expect(conversationTag(CHAT_ID)).toBe(conversationTag(String(CHAT_ID)));
    expect(conversationTag('web-session-1')).not.toBe(conversationTag('web-session-2'));
    expect(conversationTag(CHAT_ID)).not.toContain(String(CHAT_ID));
    expect(conversationTag(null)).toBe('nokey');
  });
});

describe('грейдер: потолок оценок в сутки', () => {
  it('потолок — 300', () => {
    expect(GRADER_DAILY_CAP).toBe(300);
  });

  it('300 оценок проходят, 301-я модель не зовёт и пишет в лог', async () => {
    for (let i = 0; i < GRADER_DAILY_CAP; i++) {
      await gradeKuzmichResponse(QUESTION, ANSWER, `s-${i}`, { surface: 'web' });
    }
    expect(fast).toHaveBeenCalledTimes(GRADER_DAILY_CAP);
    expect(warn).not.toHaveBeenCalled();

    await gradeKuzmichResponse(QUESTION, ANSWER, 's-301', { surface: 'web' });
    expect(fast).toHaveBeenCalledTimes(GRADER_DAILY_CAP);
    const named = warn.mock.calls.filter(([m]) => String(m).includes('потолок оценок'));
    expect(named, 'пропуск по потолку не назван в логе').toHaveLength(1);
  });

  it('место под оценку берётся в транзакции под замком', async () => {
    await gradeKuzmichResponse(QUESTION, ANSWER, CHAT_ID, { surface: 'max' });
    expect(db.tx).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock(hashtext(\'kuzmich_grade\'))', 'INSERT INTO', 'COMMIT']);
  });

  it('счёт не удался — оценка пропущена с логом, модель не зовётся', async () => {
    db.failCount = true;
    await gradeKuzmichResponse(QUESTION, ANSWER, CHAT_ID, { surface: 'web' });
    expect(fast).not.toHaveBeenCalled();
    const named = err.mock.calls.filter(([m]) => String(m).includes('[kuzmich-outcomes] потолок оценок: подсчёт за сутки'));
    expect(named, 'отказ счёта проглочен молча').toHaveLength(1);
    expect(db.tx).toContain('ROLLBACK');
  });

  it('отказ модели и короткий обрыв места не занимают и судью не зовут', async () => {
    await gradeKuzmichResponse(QUESTION, 'Извините, я не могу помочь с этим вопросом.', CHAT_ID, { surface: 'web' });
    await gradeKuzmichResponse(QUESTION, 'Связь пропала.', CHAT_ID, { surface: 'web' });
    expect(db.gradesToday).toBe(0);
    expect(fast).not.toHaveBeenCalled();
    // Отказ записан — и тоже без телефона и почты туриста.
    expect(db.knowledge).toHaveLength(1);
    const [, , text] = db.knowledge[0] as [string, string, string];
    expect(text).toContain('[телефон]');
    expect(text).not.toContain(EMAIL);
  });

  it('не оцениваемый вопрос места не занимает', async () => {
    await gradeKuzmichResponse('Привет!', ANSWER, CHAT_ID, { surface: 'web' });
    expect(db.gradesToday).toBe(0);
    expect(fast).not.toHaveBeenCalled();
  });
});
