/**
 * Два реестра дозволенного не расходятся — потому что реестр один.
 *
 * Находка аудита 08.09 (прогон 6). Рядом с политикой ядра жил второй список,
 * AUTO_EXECUTE_TYPES: «типы, которые выполняются автоматически после
 * approve». Пять из семнадцати его записей политика прямо ЗАПРЕЩАЕТ —
 * archive_sos («SOS-эффекты исключены из автономии, решение владельца
 * 27.08»), security_block, flag_payment, ab_scale_winner, operator_outreach.
 *
 * Читателей у списка не было ни одного: технически он ничего не разрешал.
 * Но он утверждал обратное решению владельца, и следующий, кто взялся бы
 * заводить автономию, прочёл бы его как разрешение. Реестр, который ничего
 * не делает и при этом врёт, опаснее отсутствующего.
 *
 * Сторож держит правило, а не этот случай: список автономно исполнимого не
 * может пересекаться с запретами политики. Если такой список заведут снова —
 * он обязан согласиться с политикой или покраснеть.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FORBIDDEN_CAPABILITIES } from '@/lib/agents/kernel/policy';

const ROOT = process.cwd();

/** Запрещённые типы инициатив без префикса. */
const FORBIDDEN_INITIATIVES = Object.keys(FORBIDDEN_CAPABILITIES)
  .filter((k) => k.startsWith('initiative.'))
  .map((k) => k.slice('initiative.'.length));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('автономия объявляется в одном месте', () => {
  it('запреты политики вообще есть — сторожу есть с чем сверять', () => {
    expect(FORBIDDEN_INITIATIVES.length).toBeGreaterThan(0);
    expect(FORBIDDEN_INITIATIVES).toContain('archive_sos');
  });

  it('второго списка автономно исполнимого не заведено', () => {
    const offenders: string[] = [];
    for (const dir of ['lib', 'app']) {
      for (const file of walk(join(ROOT, dir))) {
        const code = readFileSync(file, 'utf-8');
        const m = code.match(/AUTO_EXECUTE_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
        if (!m) continue;
        const listed = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
        const clash = listed.filter((t) => FORBIDDEN_INITIATIVES.includes(t));
        if (clash.length > 0) {
          offenders.push(`${relative(ROOT, file)}: ${clash.join(', ')}`);
        }
      }
    }
    expect(
      offenders,
      `объявлены автономными и запрещены политикой: ${offenders.join(' | ')}`,
    ).toEqual([]);
  });

  it('исполнитель архивации SOS остаётся под запретом политики', () => {
    // Владелец решил это 27.08; сторож не даёт решению истечь молча.
    expect(FORBIDDEN_CAPABILITIES['initiative.archive_sos']).toContain('SOS-эффекты исключены');
  });
});

/**
 * Словарь статусов SOS — тоже один. Условие «сигнал висит» было написано
 * словами в четырёх местах, и ни одно не знало про 'archived': сигнал,
 * заархивированный человеком, звучал бы критом ВЕЧНО. Сторож, который кричит
 * о разобранном, приучает не смотреть на сторожа.
 */
describe('«активный SOS» определяется одним словарём', () => {
  it('условие собрано из константы, а не написано словами на месте', async () => {
    const { SOS_ACTIVE_SQL, SOS_TERMINAL_STATUSES } = await import('@/lib/safety/sos-status');
    expect(SOS_TERMINAL_STATUSES).toContain('archived');
    expect(SOS_ACTIVE_SQL).toContain("'archived'");
  });

  it('своих копий условия по коду не осталось', () => {
    const copies: string[] = [];
    for (const dir of ['lib', 'app']) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).split('\\').join('/');
        if (rel === 'lib/safety/sos-status.ts') continue;
        const code = readFileSync(file, 'utf-8');
        if (!code.includes('sos_events')) continue;
        if (/status NOT IN \('resolved'/.test(code)) copies.push(rel);
      }
    }
    expect(copies, `условие «активный SOS» написано словами: ${copies.join(', ')}`).toEqual([]);
  });

  it('статуса нет — сигнал считается висящим, а не закрытым', async () => {
    const { isSosActive } = await import('@/lib/safety/sos-status');
    expect(isSosActive(null)).toBe(true);
    expect(isSosActive('active')).toBe(true);
    expect(isSosActive('archived')).toBe(false);
    expect(isSosActive('resolved')).toBe(false);
  });
});
