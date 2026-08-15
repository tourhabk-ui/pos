/**
 * Страница /operators/[slug] падала 500 на «Камчатка Семейный Рафтинг»
 * (пробы 109-110, 15.08): contacts в partners — JSONB без гарантии формы,
 * у рафтинга это ОБЪЕКТ каналов, а страница звала .flatMap как на массиве.
 *
 * Сторож держит разборщики профиля защитными: любая форма JSONB — включая
 * объект, строку, null — не бросает, а незнакомая молча даёт пустоту.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractServices, extractFeatures, extractContacts, extractFaq,
  extractGallery, extractLegalInfo,
} from '@/lib/operators/profile-parse';

// Реальная форма contacts рафтинга с прода (проба 110, снимок 15.08.2026,
// прод d13277ad) — именно на ней страница отвечала 500.
const RAFTING_CONTACTS = {
  phone: '+79147817114',
  phone2: '+79247901911',
  website: '',
  telegram: '',
  admin_name: 'Катерина',
  admin_name_2: 'Ярослав',
  telegram_channel: 'https://t.me/+GCy5EVOotCE1NDMy',
};

describe('extractContacts: обе формы JSONB', () => {
  it('объект каналов (рафтинг) — люди парами админ+номер, канал ссылкой', () => {
    const out = extractContacts(RAFTING_CONTACTS);
    expect(out).toContainEqual({ name: 'Катерина', phone: '+79147817114' });
    expect(out).toContainEqual({ name: 'Ярослав', phone: '+79247901911' });
    expect(out).toContainEqual({ label: 'Telegram-канал', href: 'https://t.me/+GCy5EVOotCE1NDMy' });
    // Пустые website/telegram не рождают строк
    expect(out.some(c => c.label === 'Сайт оператора')).toBe(false);
  });

  it('массив людей (рыбалка) — прежнее поведение сохранено', () => {
    const out = extractContacts([
      { name: 'Алексей', role: 'менеджер', phone: '+79247808011' },
      '+79147822222',
    ]);
    expect(out).toEqual([
      { name: 'Алексей', role: 'менеджер', phone: '+79247808011', address: undefined },
      { phone: '+79147822222' },
    ]);
  });

  it('null, строка, число — пустота без исключения', () => {
    expect(extractContacts(null)).toEqual([]);
    expect(extractContacts('позвоните нам')).toEqual([]);
    expect(extractContacts(42)).toEqual([]);
  });
});

describe('остальные разборщики не бросают на не-массиве', () => {
  it.each([
    ['extractServices', extractServices],
    ['extractFeatures', extractFeatures],
    ['extractFaq', extractFaq],
    ['extractGallery', extractGallery],
  ] as const)('%s(объект/null/строка) → []', (_name, fn) => {
    expect(fn({ foo: 'bar' })).toEqual([]);
    expect(fn(null)).toEqual([]);
    expect(fn('строка')).toEqual([]);
  });

  it('extractFaq режет null-элементы и пары без вопроса или ответа', () => {
    expect(extractFaq([null, { q: 'Как добраться?', a: 'Трансфер из города.' }, { q: 'без ответа' }]))
      .toEqual([{ q: 'Как добраться?', a: 'Трансфер из города.' }]);
  });

  it('extractLegalInfo: строка проходит, мусор — null', () => {
    expect(extractLegalInfo('ИНН 4101147649')).toBe('ИНН 4101147649');
    expect(extractLegalInfo(7)).toBeNull();
    expect(extractLegalInfo(null)).toBeNull();
  });
});

describe('страница оператора использует общие разборщики', () => {
  const PAGE = readFileSync(join(process.cwd(), 'app/operators/[slug]/page.tsx'), 'utf-8');

  it('импорт из lib/operators/profile-parse, своих flatMap-разборщиков нет', () => {
    expect(PAGE).toMatch(/from '@\/lib\/operators\/profile-parse'/);
    expect(PAGE).not.toMatch(/function extractContacts/);
  });

  it('ссылки-каналы (href) рендерятся', () => {
    expect(PAGE).toMatch(/c\.href/);
  });
});
