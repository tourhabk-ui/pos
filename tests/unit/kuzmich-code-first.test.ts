import { describe, it, expect } from 'vitest';
import { classifyCodeFirst, extractRequestKey, statusReplyText } from '@/lib/kuzmich/code-first';

const KEY = 'aB3dEfGh1jKlMn0pQrStUvWxYz12345_';

describe('код раньше модели', () => {
  it('ключ из ссылки статуса и голым сообщением', () => {
    expect(extractRequestKey(`https://vedarai.ru/request-status#${KEY}`)).toBe(KEY);
    expect(extractRequestKey(`статус ${KEY}`)).toBe(KEY);
    expect(extractRequestKey('хочу на рыбалку в июле')).toBeNull();
    expect(extractRequestKey('Kamchatkavolcanotrekkingadventure')).toBeNull();
  });
  it('статус решается кодом даже при открытой заявке', () => {
    expect(classifyCodeFirst(`https://vedarai.ru/request-status#${KEY}`, true).kind).toBe('status');
  });
  it('отмена и кнопки без открытой заявки', () => {
    expect(classifyCodeFirst('Отмена', false).kind).toBe('cancel_idle');
    expect(classifyCodeFirst('Да, отправить', false).kind).toBe('stale_confirm');
    expect(classifyCodeFirst('61 · Рыбалка на Озерной', false)).toEqual({ kind: 'tour', tourId: 61 });
  });
  it('внутри открытой заявки кнопки ведут её шаги, не код раньше модели', () => {
    expect(classifyCodeFirst('Отмена', true).kind).toBe('none');
    expect(classifyCodeFirst('61 · Рыбалка', true).kind).toBe('none');
  });
  it('обычный вопрос уходит модели', () => {
    expect(classifyCodeFirst('что взять на Авачу?', false).kind).toBe('none');
  });
  it('статус без ПД и без выдуманной даты', () => {
    const t = statusReplyText({ tour: 'Авача', accommodation: null, date: null, human: 'Ждёт ответа оператора.', next: 'Оператор свяжется.', page: 'https://vedarai.ru/request-status#x' });
    expect(t).toContain('Заявка: Авача.');
    expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
