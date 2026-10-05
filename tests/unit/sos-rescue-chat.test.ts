/**
 * AI Спасатель на /sos (владелец 04.10: «в сос нет ai спасателя»).
 *
 * Раньше с /sos вела ссылка в хаб — человеку в беде предлагали уйти со
 * страницы с координатами и 112. Теперь чат на самом экране, общий с
 * радаром, и стоит НИЖЕ звонка, координат, отправки и шагов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLocalProtocol, LOCAL_PROTOCOLS, OFFLINE_NO_PROTOCOL } from '@/lib/safety/rescue-protocols';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SOS = read('app/sos/page.tsx');

describe('/sos: чат на экране', () => {
  it('есть, в манере экрана SOS — без острова темы, который переопределил бы --accent/--danger', () => {
    expect(SOS).toContain("import RescueChat from '@/components/safety/RescueChat'");
    expect(SOS).toContain('<RescueChat surface="sos" />');
    expect(SOS).not.toMatch(/<[a-z]+[^>]*\sdata-theme="dark"/);
  });

  it('сразу под шагами «Что делать» — ниже звонка и координат, выше «Если связи нет» (владелец 04.10: «сложно найти»)', () => {
    expect(SOS.indexOf('<RescueChat surface="sos" />')).toBeLessThan(SOS.indexOf('Если связи нет'));
    const chat = SOS.indexOf('<RescueChat surface="sos" />');
    for (const before of ['Позвонить', 'Что делать\n']) {
      const at = SOS.indexOf(before);
      expect(at, `не найдено «${before.trim()}»`).toBeGreaterThan(-1);
      expect(at, `«${before.trim()}» должно стоять выше чата`).toBeLessThan(chat);
    }
  });

  it('радар использует тот же чат, своего нет', () => {
    const radar = read('app/safety/_SafetyClient.tsx');
    expect(radar).toContain('<RescueChat');
    expect(radar).not.toContain('sendRescueMessage');
  });
});

describe('офлайн-ответы', () => {
  it('медведь, травма, потеря, холод, землетрясение, вулкан, нет связи — каждый с 112', () => {
    for (const q of ['медведь рядом', 'сильная травма', 'заблудились', 'гипотермия', 'землетрясение', 'пепел вулкана', 'нет связи']) {
      const r = getLocalProtocol(q);
      expect(r, q).not.toBeNull();
      expect(r!).toContain('112');
    }
    expect(LOCAL_PROTOCOLS.length).toBe(7);
  });

  it('нет протокола и нет сети — «позвоните 112», без выдумки', () => {
    expect(getLocalProtocol('какая-то другая беда')).toBeNull();
    expect(OFFLINE_NO_PROTOCOL).toContain('112');
    expect(read('components/safety/RescueChat.tsx')).toContain('local ?? OFFLINE_NO_PROTOCOL');
  });
});
