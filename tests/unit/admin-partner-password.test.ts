/**
 * Пароль первого входа партнёра берётся из равномерного источника.
 *
 * CodeQL поймал на PR #879: `byte % alphabet.length` при алфавите из 54
 * символов смещает распределение — 256 на 54 нацело не делится, остаток 40,
 * значит первые сорок символов выпадают чаще остальных четырнадцати. Для
 * пароля это не косметика: неравномерность сужает пространство перебора.
 *
 * Здесь проверяется само свойство — что байты выше последней целой границы
 * отбрасываются, а не заворачиваются по кругу.
 */
import { describe, it, expect } from 'vitest';
import { generatePassword } from '@/app/api/admin/operators/create/route';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

describe('пароль для первого входа', () => {
  it('нужной длины и только из разрешённого алфавита', () => {
    const p = generatePassword();
    expect(p).toHaveLength(14);
    for (const ch of p) expect(ALPHABET).toContain(ch);
  });

  it('не содержит похожих символов — его диктуют голосом', () => {
    // 0/O, 1/l/I путаются на слух и на вид.
    for (let i = 0; i < 50; i++) {
      expect(generatePassword()).not.toMatch(/[0O1lI]/);
    }
  });

  it('байты за последней целой границей отбрасываются, а не заворачиваются', () => {
    // 4 * 54 = 216. Байт 216 при делении с остатком дал бы 'A' (216 % 54 = 0);
    // при честной отбраковке он должен быть пропущен целиком.
    const feed = [216, 217, 255, 250, 220, 230, 240, 218, 219, 221, 222, 223, 224, 225];
    let call = 0;
    const source = (n: number): Uint8Array => {
      call++;
      // Первый заход — сплошь отбраковываемые байты, дальше нули.
      return call === 1 ? Uint8Array.from(feed.slice(0, n)) : new Uint8Array(n);
    };
    const p = generatePassword(source);
    expect(call, 'источник не был запрошен повторно — значит байты не отбрасывались')
      .toBeGreaterThan(1);
    expect(p).toBe('A'.repeat(14)); // нули второго захода → первый символ алфавита
  });

  it('распределение ровное: ни один символ не доминирует', () => {
    // Грубая, но честная проверка равномерности на большой выборке.
    // При смещении по модулю первые 40 символов получали бы примерно на
    // четверть больше попаданий, чем последние 14.
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      for (const ch of generatePassword()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const head = ALPHABET.slice(0, 40).split('').reduce((s, c) => s + (counts.get(c) ?? 0), 0) / 40;
    const tail = ALPHABET.slice(40).split('').reduce((s, c) => s + (counts.get(c) ?? 0), 0) / 14;
    const ratio = head / tail;
    expect(ratio, `частоты разошлись: ${ratio.toFixed(3)}`).toBeGreaterThan(0.9);
    expect(ratio, `частоты разошлись: ${ratio.toFixed(3)}`).toBeLessThan(1.1);
  });
});
