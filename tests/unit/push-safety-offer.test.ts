/**
 * Сторож предложения подписаться на предупреждения.
 *
 * Watchdog 23.08.2026: «Push-канал пуст: подписчиков 0, доставлять некому.
 * 18 предупреждений не ушло — это следствие пустого канала, а не отказ
 * доставки».
 *
 * Механика была ЦЕЛАЯ: service worker регистрируется в корневом layout, VAPID
 * настроен, подписка и отправка работают. Не работало РАСПОЛОЖЕНИЕ:
 * предложение стояло на /safety и в личном кабинете — там, куда человек
 * заходит, УЖЕ решив позаботиться. Турист, думающий о безопасности, в этот
 * момент готовится к своему маршруту.
 *
 * Здесь закреплены три свойства: обещание живёт в одном месте, действие —
 * одно на всю платформу, и предложение стоит там, где человек ещё в сети.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const OFFER = read('components/PWA/PushSafetyOffer.tsx');
const PREPARE = read('app/routes/[id]/prepare/_PrepareClient.tsx');
const SAFETY = read('app/safety/_SafetyClient.tsx');

/** Слова обещания: что именно человеку обещают прислать. */
const PROMISE = 'Цунами, сейсмо, вулканы, перекрытия дорог';

describe('обещание живёт в одном месте', () => {
  const SKIP = new Set(['node_modules', '.next', '.git', '.claude', 'public', 'migrations', 'docs', 'tests']);
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(e)) acc.push(p);
    }
    return acc;
  };

  it('текст обещания встречается ровно в одном файле', () => {
    // Две копии обещания — это два обещания, и однажды они разойдутся.
    const holders = walk(process.cwd())
      .filter((f) => readFileSync(f, 'utf8').includes(PROMISE))
      .map((f) => f.replace(process.cwd() + '/', ''));
    expect(holders).toEqual(['components/PWA/PushSafetyOffer.tsx']);
  });

  it('обещание называет конкретные поводы, а не «важные уведомления»', () => {
    // Человек соглашается на то, что ему назвали. Обещать «важное» и слать
    // что придётся — способ получить отписку, и заслуженно.
    expect(OFFER).toContain(PROMISE);
  });
});

describe('действие одно на всю платформу', () => {
  it('предложение переиспользует кнопку, а не заводит вторую подписку', () => {
    expect(OFFER).toMatch(/import \{ PushSubscribeButton \}/);
    expect(OFFER, 'вторая реализация подписки').not.toMatch(/pushManager\.subscribe/);
  });

  it('подписка вызывается ровно из одного компонента', () => {
    const subscribers = readdirSync(join(process.cwd(), 'components/PWA'))
      .filter((f) => readFileSync(join(process.cwd(), 'components/PWA', f), 'utf8').includes('pushManager.subscribe'));
    expect(subscribers).toEqual(['PushSubscribeButton.tsx']);
  });
});

describe('предложение стоит там, где человек ещё в сети', () => {
  it('экран подготовки к маршруту его показывает', () => {
    // Момент подписки — подготовка к конкретному маршруту: человек уже думает
    // о безопасности и ещё в зоне связи. В поле подписываться поздно.
    expect(PREPARE).toMatch(/import \{ PushSafetyOffer \}/);
    expect(PREPARE).toMatch(/<PushSafetyOffer\s*\/>/);
  });

  it('/safety тоже переведён на общий компонент', () => {
    expect(SAFETY).toMatch(/<PushSafetyOffer/);
    expect(SAFETY, 'на /safety осталась своя вёрстка предложения')
      .not.toMatch(/<PushSubscribeButton\s*\/>/);
  });
});
