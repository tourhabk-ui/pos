/**
 * Письмо с данными выезда для МЧС (слово владельца 10.11: «можем попробывать
 * пока письмом на flo@vedarai.ru потом после тестов свяжусь с МЧС») — вызовом.
 *
 * Держит:
 *  - пока это тест, получатель — ящик Ведара, а письмо и каждый экран говорят,
 *    что в МЧС оно не уходило: «отправлено» без «куда» человек прочитает как
 *    «подано в МЧС» и форму МЧС не откроет;
 *  - три исхода отправки: ушло / не ушло / почта не настроена — и причина
 *    отказа без адресов и телефонов;
 *  - журнал не несёт имён и телефонов туристов;
 *  - «Да, отправить» — кнопка-запись (подпись и срок), вопрос — чтение.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ mail: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/notifications/email-service', () => ({ emailService: { sendEmail: (...a: unknown[]) => m.mail(...a) } }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.query(...a) } }));

const {
  MCHS_LETTER, MCHS_LETTER_REPEAT_MS, MCHS_LETTER_TEST_BANNER, MCHS_LETTER_TEXT, mchsLetterHtml, mchsLetterSubject,
} = await import('@/lib/safety/mchs-letter-text');
const { lastMchsLetter, recordMchsLetter, sendMchsLetter } = await import('@/lib/safety/mchs-letter');
const { cabinetPayload, parseCabinetPress } = await import('@/lib/chat-cabinet/payload');
const { isWritePayload } = await import('@/lib/chat-cabinet/signed-payload');
const { mchsGroupScreen, mchsLetterAskScreen, mchsLetterResultScreen } = await import('@/lib/chat-cabinet/mchs-screens');
const { MCHS_ONLINE_FORM_URL } = await import('@/lib/safety/mchs-registration');
type MchsGroup = import('@/lib/safety/mchs-chat').MchsGroup;

const NOW = Date.UTC(2026, 10, 10, 0, 0);
const PID = '11111111-1111-4111-8111-111111111111';

const group = (over: Partial<MchsGroup> = {}): MchsGroup => ({
  date: '2027-07-19', endDate: '2027-07-22', tourId: '81', title: 'Курильское озеро, 4 дня',
  people: 6, bookings: 2, routeTitle: 'Курильское озеро', required: true, mchsPhone: null,
  contacts: [{ name: 'Тест', phone: '+70000000000', participants: 2 }, { name: 'Тест второй', phone: null, participants: 4 }],
  ...over,
});
const sender = { partnerId: PID, partnerName: 'Оператор <Тест>', role: 'operator' as const, channel: 'telegram' as const };

beforeEach(() => {
  m.mail.mockReset();
  m.query.mockReset();
  vi.stubEnv('SMTP_USER', 'robot');
  vi.stubEnv('SMTP_PASS', 'x');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('пока это тест', () => {
  it('получатель — ящик Ведара; перевод на адрес МЧС — отдельное решение, а не правка одной строки', () => {
    // Сменить получателя на МЧС значит переписать тексты экранов и письма,
    // согласие на передачу ПД и этот сторож — одним коммитом, по слову владельца.
    expect(MCHS_LETTER.test, 'письмо перестало быть тестовым: перепишите тексты, согласие и сторож').toBe(true);
    expect(MCHS_LETTER.to.endsWith('@vedarai.ru')).toBe(true);
  });

  it('тема и тело называют письмо тестовым и говорят, что в МЧС оно не уходило', () => {
    expect(mchsLetterSubject(group())).toBe('[ТЕСТ] Регистрация туристской группы: Курильское озеро, 4 дня, 19.07.2027 — 22.07.2027');
    const html = mchsLetterHtml(group(), sender, NOW);
    expect(html).toContain(MCHS_LETTER_TEST_BANNER);
    expect(MCHS_LETTER_TEST_BANNER).toContain('В МЧС не отправлялось');
    expect(html).toContain('Оператор &lt;Тест&gt; (туроператор)');
    expect(html).toContain('1. Тест, тел. +70000000000, 2 чел.');
    expect(html).toContain(MCHS_ONLINE_FORM_URL);
  });

  it('письмо несёт все контактные лица, а не первые двадцать пять, как сообщение чата', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `Тест ${i + 1}`, phone: null, participants: 1 }));
    const html = mchsLetterHtml(group({ contacts: many }), sender, NOW);
    expect(html).toContain('30. Тест 30, 1 чел.');
    expect(html).not.toContain('и ещё');
  });

  it('перевод строки в названии тура не дописывает заголовки письма', () => {
    const subject = mchsLetterSubject(group({ title: 'Тур\r\nBcc: x@example.com' }));
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('каждое слово кабинета об отправке называет, куда ушло письмо, и не выдаёт его за заявку', () => {
    const said = [
      MCHS_LETTER_TEXT.askWhere, MCHS_LETTER_TEXT.sent, MCHS_LETTER_TEXT.recent('10.11 14:05'), MCHS_LETTER_TEXT.last('10.11 14:05'),
    ];
    for (const text of said) {
      expect(text, text).toMatch(/тестовый ящик Ведара|ящик Ведара/);
      expect(text, text).toMatch(/не в МЧС|В МЧС оно не отправлено|В МЧС — нет/);
    }
    // Запрет: ни одно слово не утверждает подачу или регистрацию в МЧС.
    const all = Object.values(MCHS_LETTER_TEXT).map((v) => (typeof v === 'function' ? v('x') : v)).join('\n');
    expect(all).not.toMatch(/заявка (подана|принята|отправлена) в МЧС|зарегистрирован/i);
    expect(MCHS_LETTER_TEXT.button).toContain('тест');
  });
});

describe('отправка: три исхода', () => {
  it('почта не настроена — «не настроено», до почтового сервера не идём', async () => {
    vi.stubEnv('SMTP_PASS', '');
    expect(await sendMchsLetter(group(), sender, NOW)).toEqual({ outcome: 'not_configured', error: null });
    expect(m.mail).not.toHaveBeenCalled();
  });

  it('ушло — на ящик из MCHS_LETTER, с темой и телом', async () => {
    m.mail.mockResolvedValue({ success: true, messageId: 'x' });
    expect(await sendMchsLetter(group(), sender, NOW)).toEqual({ outcome: 'sent', error: null });
    const mail = m.mail.mock.calls[0]![0] as { to: string; subject: string; html: string };
    expect(mail.to).toBe(MCHS_LETTER.to);
    expect(mail.subject).toContain('[ТЕСТ]');
    expect(mail.html).toContain(MCHS_LETTER_TEST_BANNER);
  });

  it('не ушло — причина без адреса и телефона; исключение почты — тоже «не ушло»', async () => {
    m.mail.mockResolvedValue({ success: false, error: '550 <ivan@example.com>: user unknown, tel +79140001122' });
    const r = await sendMchsLetter(group(), sender, NOW);
    expect(r.outcome).toBe('failed');
    expect(r.error).not.toContain('ivan@example.com');
    expect(r.error).not.toContain('+79140001122');
    m.mail.mockRejectedValue(new Error('ETIMEDOUT'));
    expect(await sendMchsLetter(group(), sender, NOW)).toEqual({ outcome: 'failed', error: 'ETIMEDOUT' });
  });
});

describe('журнал без персональных данных', () => {
  it('запись — карточка, тур, дата, канал, получатель, тест, исход и счёт; ни имён, ни телефонов', async () => {
    m.query.mockResolvedValue({ rows: [], rowCount: 1 });
    expect(await recordMchsLetter({ sender, group: group(), outcome: 'sent', error: null })).toBe(true);
    const [sql, params] = m.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('INSERT INTO mchs_letters');
    expect(params).toEqual([PID, '81', '2027-07-19', 'telegram', MCHS_LETTER.to, true, 'sent', null, 6, 2]);
    expect(JSON.stringify(params)).not.toMatch(/Тест|\+7000/);
  });

  it('последнее письмо: было недавно / было давно / не было / журнал не прочитался', async () => {
    m.query.mockResolvedValueOnce({ rows: [{ at: '2026-11-10 02:05:00+00', recent: true }] });
    expect(await lastMchsLetter(PID, '81', '2027-07-19')).toEqual({ at: '2026-11-10 02:05:00+00', recent: true });
    expect(m.query.mock.calls[0]![1]).toEqual([PID, '81', '2027-07-19', MCHS_LETTER_REPEAT_MS / 1000]);
    m.query.mockResolvedValueOnce({ rows: [{ at: '2026-11-09 02:05:00+00', recent: false }] });
    expect(await lastMchsLetter(PID, '81', '2027-07-19')).toMatchObject({ recent: false });
    m.query.mockResolvedValueOnce({ rows: [] });
    expect(await lastMchsLetter(PID, '81', '2027-07-19')).toBeNull();
    m.query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '42P01' }));
    expect(await lastMchsLetter(PID, '81', '2027-07-19')).toBe('failed');
    m.query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    expect(await recordMchsLetter({ sender, group: group(), outcome: 'sent', error: null })).toBe(false);
  });
});

describe('кнопки и экраны', () => {
  it('вопрос — чтение, «Да, отправить» — запись с подписью; обе разбираются обратно', () => {
    expect(parseCabinetPress(cabinetPayload.mchsLetterAsk('81', '2027-07-19'))).toEqual({ kind: 'mchs_letter_ask', tourId: '81', date: '2027-07-19' });
    expect(parseCabinetPress('cb:mc:s:81:20270719')).toEqual({ kind: 'mchs_letter_send', tourId: '81', date: '2027-07-19' });
    expect(parseCabinetPress('cb:mc:s:81:20270231')).toBeNull();
    expect(isWritePayload('cb:mc:s:81:20270719')).toBe(true);
    expect(isWritePayload('cb:mc:q:81:20270719')).toBe(false);
    expect(isWritePayload('cb:mc:81:20270719')).toBe(false);
    vi.stubEnv('CALLBACK_SIGNING_SECRET', 'k');
    const signed = cabinetPayload.mchsLetterSend('9'.repeat(18), '2027-07-19');
    expect(signed.split('~')).toHaveLength(3);
    expect(Buffer.byteLength(signed)).toBeLessThanOrEqual(64);
  });

  it('кнопка «Отправить письмом» — только когда разрешено; строка о прошлом письме видна', () => {
    const payloads = (rows: Array<Array<{ payload?: string }>>) => rows.flat().map((b) => b.payload);
    const off = mchsGroupScreen({ group: group(), role: 'operator', base: 'https://vedarai.ru', nowMs: NOW });
    expect(payloads(off.rows)).not.toContain('cb:mc:q:81:20270719');
    const on = mchsGroupScreen({
      group: group(), role: 'operator', base: 'https://vedarai.ru', nowMs: NOW, canSend: true, letterLine: MCHS_LETTER_TEXT.last('10.11 14:05'),
    });
    expect(payloads(on.rows)).toContain('cb:mc:q:81:20270719');
    expect(on.text).toContain('Письмо (тест) по этому выезду уже уходило на ящик Ведара 10.11 14:05 по Камчатке. В МЧС — нет.');
  });

  it('вопрос и итог — без имён и телефонов, с формой МЧС в итоге', () => {
    const ask = mchsLetterAskScreen({ group: group(), nowMs: NOW });
    expect(ask.pd).toBe(false);
    expect(ask.text).not.toMatch(/Тест|\+7/);
    expect(ask.text).toContain('не в МЧС');
    expect(ask.rows[0]![0]).toMatchObject({ text: 'Да, отправить', payload: 'cb:mc:s:81:20270719' });
    const done = mchsLetterResultScreen({ text: MCHS_LETTER_TEXT.sent, tourId: '81', date: '2027-07-19' });
    expect(done.pd).toBe(false);
    expect(done.failed).toBeUndefined();
    expect(done.rows.flat().some((b) => 'url' in b && b.url === MCHS_ONLINE_FORM_URL)).toBe(true);
    expect(mchsLetterResultScreen({ text: MCHS_LETTER_TEXT.unchecked, tourId: '81', date: '2027-07-19', failed: true }).failed).toBe(true);
  });
});
