/**
 * «Отправь группе свой план» — главный реферальный сценарий (стратегия 14.08).
 *
 * Не «пригласи друга ради баллов», а совместный объект — план поездки:
 * решение о Камчатке принимают семьёй или компанией. Ссылка залогиненного
 * несёт его метку (KH-код), получатели видят тот же маршрут; отправка в
 * Telegram считается действием исполнения. Безопасность (SOS, предупреждения,
 * регистрация МЧС) меткой НЕ гейтится — это закреплено сторожем.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const TRIP = read('app/trip/[token]/_TripShareClient.tsx');
const PLANNER = read('app/planner/_PlannerClient.tsx');

describe('ссылка плана несёт метку владельца кода', () => {
  it('страница плана: withReferral + свой код через общий хук', () => {
    expect(TRIP).toMatch(/useMyReferralCode/);
    expect(TRIP).toMatch(/withReferral\(rawShareUrl, myCode\)/);
  });

  it('планировщик: та же механика на панели шаринга', () => {
    expect(PLANNER).toMatch(/useMyReferralCode\(!!initialUserId\)/);
    expect(PLANNER).toMatch(/withReferral\(shareUrl, myReferralCode\)/);
  });

  it('метка — только через lib/referral/link, без ручной склейки ?ref=', () => {
    // withReferral валидирует формат KH-кода и не путает его с агентскими
    // ссылками; ручная склейка это правило обошла бы.
    expect(TRIP).not.toMatch(/[?&]ref=\$\{/);
    expect(PLANNER).not.toMatch(/[?&]ref=\$\{/);
  });
});

describe('отправка в Telegram — действие исполнения', () => {
  it('обе поверхности шлют plan_sent_to_telegram', () => {
    expect(TRIP).toMatch(/funnelBeacon\('plan_sent_to_telegram', token\)/);
    expect(PLANNER).toMatch(/funnelBeacon\('plan_sent_to_telegram'/);
  });
});

describe('безопасность меткой не гейтится', () => {
  it('блоки МЧС и GPX на странице плана не зависят от реферального кода', () => {
    // Кнопки регистрации и офлайн-пакета не могут оказаться внутри условия
    // по myCode: доступ к безопасности — не награда.
    const mchsBlock = TRIP.slice(TRIP.indexOf('регистрация в МЧС') - 500, TRIP.indexOf('Форма МЧС напрямую'));
    expect(mchsBlock).not.toMatch(/myCode/);
    const gpxBlock = TRIP.slice(TRIP.indexOf('В поход без связи') - 300, TRIP.indexOf('Скачать GPX'));
    expect(gpxBlock).not.toMatch(/myCode/);
  });
});
