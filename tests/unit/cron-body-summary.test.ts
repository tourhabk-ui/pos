// @vitest-environment node
/**
 * Сводка ответа крона вместо тела в публичном логе Actions (перепись 23.11).
 *
 * Репозиторий публичный. Шаги кронов печатали тело ответа прода целиком:
 * имена операторов и номера броней (rescue), номера заявок с текстом ошибки
 * (leads-process), тексты задач ядра (kernel-worker), фрагменты запросов к
 * инструментам MCP (mcp-census). Сводка печатает числа и состояния; строки
 * данных — нет. Судится вызовом и исполнением шагов workflow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { summarizeBody, scrubError, bodyLogLines } from '../../scripts/cron-body-summary.mjs';

const ROOT = process.cwd();

describe('сводка тела', () => {
  it('числа и слова-состояния — как есть; свободный текст — только длина', () => {
    expect(summarizeBody({
      success: true, processed: 3, skipped: 'lease_held', at: '2026-11-23T06:12:00.000Z', reason: null,
      note: 'Оператор «Тест» без броней 9 дней', phase: 'two words',
    })).toEqual([
      'success: true', 'processed: 3', 'skipped: lease_held', 'at: 2026-11-23T06:12:00.000Z', 'reason: null',
      'note: строка, 33 зн.', 'phase: строка, 9 зн.',
    ]);
  });

  it('массив — только длина: строки данных в лог не идут', () => {
    const lines = summarizeBody({
      alerts: [{ type: 'churn', details: 'Тест — бронь #812 (4 чел.)' }, { type: 'weather' }],
      booking_ids_sent: [812, 813, 814],
      results: [{ id: 77, ok: false, error: 'relation "x" does not exist' }],
    });
    expect(lines).toEqual(['alerts: [2]', 'booking_ids_sent: [3]', 'results: [1]']);
    expect(lines.join('\n')).not.toMatch(/812|Тест|relation/);
  });

  it('поле про человека скрыто, как бы оно ни было записано и каким бы ни было значение', () => {
    const lines = summarizeBody({
      tourist_name: 'Ivan', telegramChatId: 123456, userId: 'u-1', phone: 79000000000, lat: 53.02, lng: 158.65,
      last_error_message: 'x', contact: { email: 'a@b.ru' }, users_checked: 12, context_len: 900, skip_reason: 'no_data',
    }).join('\n');
    for (const hidden of ['tourist_name', 'telegramChatId', 'userId', 'phone', 'lat', 'lng', 'last_error_message', 'contact.email']) {
      expect(lines).toContain(`${hidden}: скрыто`);
    }
    expect(lines).not.toMatch(/Ivan|123456|u-1|79000000000|53\.02|158\.65|a@b\.ru/);
    // Счётчики с похожими именами остаются числами.
    expect(lines).toContain('users_checked: 12');
    expect(lines).toContain('context_len: 900');
    expect(lines).toContain('skip_reason: no_data');
  });

  it('номер под нейтральным именем не печатается: длинные цифры и большое число', () => {
    const lines = summarizeBody({ ref: '+79001234567', ticket: '20261123777', owner: 5123456789, small: 4096 }).join('\n');
    expect(lines).not.toMatch(/79001234567|20261123777|5123456789/);
    expect(lines).toContain('owner: число, 10 зн.');
    expect(lines).toContain('small: 4096');
  });

  it('вложенность — два уровня, глубже только число ключей', () => {
    expect(summarizeBody({ delivery: { status: 'failed', detail: { code: 400, more: { a: 1 } } } })).toEqual([
      'delivery.status: failed', 'delivery.detail: {ключей: 2}',
    ]);
  });

  it('не объект, пустое и не JSON — названы, содержимое не печатается', () => {
    expect(bodyLogLines('', 200)).toEqual(['тело пустое']);
    expect(bodyLogLines('<html>Иванов Иван +7 900 000-00-00</html>', 502)).toEqual(['тело не JSON, 41 зн. — не печатается']);
    expect(summarizeBody([1, 2])).toEqual(['массив из 2']);
    expect(summarizeBody({})).toEqual(['пустой объект']);
  });

  it('при отказе печатается ошибка без значений; при 200 — нет', () => {
    const body = JSON.stringify({ error: 'duplicate key: Key (email)=(ivan@example.ru) "Иванов" phone +7 (900) 000-00-00 в «Тест»' });
    const failed = bodyLogLines(body, 500).join('\n');
    expect(failed).toContain('ошибка (без значений):');
    expect(failed).not.toMatch(/ivan@example\.ru|Иванов|900|Тест/);
    expect(bodyLogLines(body, 200).join('\n')).not.toContain('ошибка (без значений)');
    expect(scrubError('x'.repeat(900))).toHaveLength(300);
  });
});

describe('шаги workflow печатают сводку, а не тело', () => {
  const read = (f: string) => readFileSync(join(ROOT, '.github/workflows', f), 'utf-8');

  // Запрет: тело ответа прода в этих файлах не печатается.
  it.each(['cron-safety-heartbeat.yml', 'cron-tour-reminder.yml', 'cron-tour-review-request.yml'])('%s: `cat` тела нет', (f) => {
    const src = read(f);
    expect(src).not.toMatch(/\bcat \/tmp\/[\w.-]+\.json/);
    expect(src).toContain('node scripts/cron-body-summary.mjs');
    expect(src).toContain('actions/checkout@');
  });

  it('перепись MCP: фрагменты запросов (arg_value) в лог не идут', () => {
    const src = read('west-knowledge-probe.yml');
    expect(src).not.toMatch(/jq '\.' \/tmp\/mcp\.json/);
    expect(src).toContain("del(.errors_external[]?.arg_value)");
  });

  it('исполнение: шаг rescue с телом, где имена и номера, печатает только сводку', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-summary-'));
    const file = join(dir, 'rescue.json');
    writeFileSync(file, JSON.stringify({
      success: true, alerts: [{ details: 'ООО Тест — бронь #812 (4 чел.)' }], churn: [{ name: 'ООО Тест', last: '2026-11-10' }], checked: 8,
    }));
    const run = spawnSync('node', [join(ROOT, 'scripts/cron-body-summary.mjs'), file, '200'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split('\n')).toEqual(['success: true', 'alerts: [1]', 'churn: [1]', 'checked: 8']);
    // Файла нет — шаг не падает на сводке: исход решает код HTTP.
    const missing = spawnSync('node', [join(ROOT, 'scripts/cron-body-summary.mjs'), join(dir, 'нет.json'), '000'], { encoding: 'utf8' });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain('файла ответа нет');
  });

  // Каждый workflow, зовущий сводку, должен сначала взять репозиторий.
  it('у каждого workflow со сводкой есть checkout раньше первого вызова', () => {
    const users = readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml') && read(f).includes('scripts/cron-body-summary.mjs'));
    expect(users.length).toBeGreaterThanOrEqual(3);
    for (const f of users) {
      const src = read(f);
      expect(src.indexOf('actions/checkout@'), f).toBeGreaterThan(-1);
      expect(src.indexOf('actions/checkout@'), f).toBeLessThan(src.indexOf('scripts/cron-body-summary.mjs'));
    }
  });
});
