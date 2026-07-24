import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { encryptPayoutDetails, decryptPayoutDetails } from '@/lib/operators/payout-details';

const KEY = 'a'.repeat(64); // 64 hex = 32 байта — валидный ENCRYPTION_KEY

describe('payout-details — шифрование финансовых реквизитов', () => {
  let prevKey: string | undefined;
  beforeAll(() => { prevKey = process.env.ENCRYPTION_KEY; process.env.ENCRYPTION_KEY = KEY; });
  afterAll(() => { if (prevKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = prevKey; });

  it('round-trip: зашифровал → расшифровал → те же реквизиты', () => {
    const details = { inn: '7712345678', bik: '044525225', account: '40702810000000000000', name: 'ООО «Ромашка»' };
    const enc = encryptPayoutDetails(details);
    expect(enc).not.toBeNull();
    const back = decryptPayoutDetails(JSON.parse(enc!)); // pg вернул бы JSON-строку как JS-строку
    expect(back).toEqual(details);
  });

  it('шифртекст НЕ содержит реквизитов в открытом виде', () => {
    const enc = encryptPayoutDetails({ phone: '+79001234567' })!;
    expect(enc).not.toContain('+79001234567');
    expect(enc).not.toContain('79001234567');
  });

  it('legacy plaintext (JSONB-объект) читается как есть', () => {
    const legacy = { method: 'sbp', phone: '+79001112233' };
    expect(decryptPayoutDetails(legacy)).toEqual(legacy);
  });

  it('пусто → null', () => {
    expect(decryptPayoutDetails(null)).toBeNull();
    expect(decryptPayoutDetails(undefined)).toBeNull();
  });

  it('битый шифртекст → null (а не падение)', () => {
    expect(decryptPayoutDetails('не:шифр:текст')).toBeNull();
  });
});

describe('payout-details — без ключа шифрование недоступно', () => {
  let prevKey: string | undefined;
  beforeAll(() => { prevKey = process.env.ENCRYPTION_KEY; delete process.env.ENCRYPTION_KEY; });
  afterAll(() => { if (prevKey !== undefined) process.env.ENCRYPTION_KEY = prevKey; });

  it('encryptPayoutDetails → null (вызывающий обязан вернуть ошибку, не plaintext)', () => {
    expect(encryptPayoutDetails({ inn: '7712345678' })).toBeNull();
  });
});
