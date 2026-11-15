/**
 * Код подтверждения заявки внешнего агента (#3399, п. 4, lib/mcp/human-confirmation).
 *
 * Код привязан к инструменту и полям заявки: другой человек, другой тур, другая
 * дата — другой код; порядок ключей и пробелы по краям значения не меняют;
 * согласие, проба и сам код в него не входят. Истёк — «истёк», секрета нет —
 * «недоступно», а не «прошло».
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { issueHumanConfirmation, checkHumanConfirmation, confirmationCanon, HUMAN_CONFIRM_TTL_MIN } from '@/lib/mcp/human-confirmation';

const ARGS = { tour: '36', date: '2099-11-09', participants: 2, name: 'Тест', phone: '+70000000000', consent: false };
const NOW = Date.UTC(2099, 0, 1, 12, 0, 0);

let saved: { salt?: string; cron?: string };
beforeEach(() => {
  saved = { salt: process.env.MCP_HASH_SALT, cron: process.env.CRON_SECRET };
  process.env.MCP_HASH_SALT = 'test-salt';
});
afterEach(() => {
  if (saved.salt === undefined) delete process.env.MCP_HASH_SALT; else process.env.MCP_HASH_SALT = saved.salt;
  if (saved.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.cron;
});

describe('код подтверждения заявки', () => {
  it('тот же инструмент и те же поля — код подходит; согласие и проба в код не входят', () => {
    const code = issueHumanConfirmation('create_booking_request', ARGS, NOW)!;
    expect(checkHumanConfirmation(code, 'create_booking_request', { ...ARGS, consent: true }, NOW)).toBe('ok');
    expect(checkHumanConfirmation(code, 'create_booking_request', { ...ARGS, consent: true, confirmation: code, test: false }, NOW)).toBe('ok');
  });

  it('порядок ключей и пробелы по краям не меняют код', () => {
    const shuffled = { phone: ' +70000000000 ', name: 'Тест', participants: 2, date: '2099-11-09', tour: '36' };
    expect(confirmationCanon('create_booking_request', shuffled)).toBe(confirmationCanon('create_booking_request', ARGS));
  });

  it('поменялось поле или инструмент — код не подходит', () => {
    const code = issueHumanConfirmation('create_booking_request', ARGS, NOW)!;
    expect(checkHumanConfirmation(code, 'create_booking_request', { ...ARGS, phone: '+79000000000' }, NOW)).toBe('mismatch');
    expect(checkHumanConfirmation(code, 'create_booking_request', { ...ARGS, date: '2099-11-10' }, NOW)).toBe('mismatch');
    expect(checkHumanConfirmation(code, 'create_booking_request', { ...ARGS, comment: 'ещё' }, NOW)).toBe('mismatch');
    expect(checkHumanConfirmation(code, 'create_lead', ARGS, NOW)).toBe('mismatch');
  });

  it('подделка и мусор — не подходят', () => {
    const code = issueHumanConfirmation('create_booking_request', ARGS, NOW)!;
    const [exp] = code.split('.');
    expect(checkHumanConfirmation(`${exp}.${'A'.repeat(22)}`, 'create_booking_request', ARGS, NOW)).toBe('mismatch');
    // Срок продлить нельзя: он под подписью.
    const later = (parseInt(exp, 36) + 600).toString(36);
    expect(checkHumanConfirmation(`${later}.${code.split('.')[1]}`, 'create_booking_request', ARGS, NOW)).toBe('mismatch');
    expect(checkHumanConfirmation('да', 'create_booking_request', ARGS, NOW)).toBe('mismatch');
  });

  it(`код живёт ${HUMAN_CONFIRM_TTL_MIN} минут`, () => {
    const code = issueHumanConfirmation('create_booking_request', ARGS, NOW)!;
    expect(checkHumanConfirmation(code, 'create_booking_request', ARGS, NOW + (HUMAN_CONFIRM_TTL_MIN - 1) * 60000)).toBe('ok');
    expect(checkHumanConfirmation(code, 'create_booking_request', ARGS, NOW + (HUMAN_CONFIRM_TTL_MIN + 2) * 60000)).toBe('expired');
  });

  it('секрета нет — кода не выдаём и не пускаем, а не «прошло»', () => {
    const code = issueHumanConfirmation('create_booking_request', ARGS, NOW)!;
    delete process.env.MCP_HASH_SALT;
    delete process.env.CRON_SECRET;
    expect(issueHumanConfirmation('create_booking_request', ARGS, NOW)).toBeNull();
    expect(checkHumanConfirmation(code, 'create_booking_request', ARGS, NOW)).toBe('unavailable');
  });
});
