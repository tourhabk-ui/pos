/**
 * Диагностика ключа Qwen отвечает, а не подсказывает.
 *
 * Повод: DASHSCOPE_API_KEY отдавал `401 Incorrect API key`, и дальше начиналось
 * гадание. У DashScope ДВА независимых шлюза — международный (ключи из консоли
 * alibabacloud.com) и китайский (aliyun.com / Bailian). Ключ, выпущенный в
 * одном, отвечает в другом ровно этой 401: он не «неверный», он «не отсюда».
 *
 * Прежняя проба стучалась только в настроенный шлюз и различить эти случаи не
 * могла — в алерт уходила подсказка «проверь регион консоли». Подсказка
 * заставляет владельца проверять руками то, что код может проверить сам.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QWEN_BASE_INTL, QWEN_BASE_CN } from '@/lib/ai/providers';

const ROOT = process.cwd();
const providers = readFileSync(join(ROOT, 'lib/ai/providers.ts'), 'utf-8');
const health = readFileSync(join(ROOT, 'app/api/cron/health/route.ts'), 'utf-8');

/**
 * Тело функции — до следующего верхнеуровневого объявления. Не `\n\}`: внутри
 * есть вложенные блоки, и нежадный поиск обрывал функцию на первой же
 * закрывающей скобке в начале строки (270 символов из 2600).
 */
const probe = providers.match(
  /export async function probeQwenRegions[\s\S]*?\n(?=export |\/\*\*)/,
)?.[0] ?? '';

describe('шлюзы DashScope разведены', () => {
  it('оба региона заданы и различаются', () => {
    expect(QWEN_BASE_INTL).not.toBe(QWEN_BASE_CN);
    expect(QWEN_BASE_INTL).toContain('dashscope-intl');
    expect(QWEN_BASE_CN).toContain('dashscope.aliyuncs.com');
  });
});

describe('проба стучится в оба шлюза', () => {
  it('тело функции найдено', () => {
    expect(probe.length).toBeGreaterThan(400);
  });

  it('проверяются оба региона, а не только настроенный', () => {
    expect(probe).toMatch(/region: 'intl'/);
    expect(probe).toMatch(/region: 'cn'/);
    expect(probe).toMatch(/Promise\.all/);
  });

  it('возвращает рабочий шлюз, а не только статусы', () => {
    expect(probe).toMatch(/working_base/);
    expect(probe).toMatch(/QWEN_BASE_URL=/);
  });
});

describe('вердикт различает три разных случая', () => {
  it('ключ живой, но шлюз настроен не тот', () => {
    expect(probe).toMatch(/настроен другой шлюз/);
  });

  it('ключ отвергнут в обоих — это перевыпуск', () => {
    expect(probe).toMatch(/отвергнут в ОБОИХ/);
  });

  it('шлюзы недоступны — это сеть, а не ключ', () => {
    // Путать «ключ мёртв» и «до шлюза не достучались» дорого: лечится разным.
    expect(probe).toMatch(/шлюзы недоступны/);
    expect(probe).toMatch(/ключ ни при чём/);
  });
});

describe('health отдаёт ответ вместо гипотезы', () => {
  it('на 401/403 запускает проверку обоих регионов', () => {
    expect(health).toMatch(/probeQwenRegions/);
    expect(health).toMatch(/http_status === 401/);
  });

  it('вердикт попадает в текст алерта', () => {
    expect(health).toMatch(/regions\.verdict/);
  });
});
