/**
 * Сторож пинов: сторонний экшен берётся по хешу коммита, а не по тегу.
 *
 * actions/unpinned-tag, 6 находок языка `actions` (CodeQL, 23.08.2026).
 * Тег — не адрес, а имя, и переставляет его владелец экшена когда угодно.
 * Самый резкий случай был у AI-ревью безопасности: `@main`, то есть «что
 * лежит на ветке в момент запуска», причём с нашим CLAUDE_API_KEY и правами
 * pull-requests: write.
 *
 * Экшены самого GitHub (`actions/*`) правило не трогает, и мы тоже: они
 * поставляются платформой, у них другая модель доверия, и CodeQL их не
 * отмечал. Сторож повторяет ту же границу — иначе он краснел бы на
 * actions/checkout в каждом файле и его бы выключили.
 *
 * КАК ОБНОВЛЯТЬ (пин отключает автообновление — это осознанная цена):
 *   git ls-remote --tags https://github.com/<owner>/<repo> | grep 'v1'
 * Брать ОЧИЩЕННЫЙ хеш — строку с `^{}`, если она есть: у аннотированного тега
 * первая строка указывает на объект тега, и пин на него не сработает.
 * У anthropics/claude-code-action тег v1 именно аннотированный.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const WF_DIR = join(process.cwd(), '.github/workflows');
const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));

/** `uses: owner/repo@ref` — без локальных (`./`) и докерных (`docker://`). */
const USES = /uses:\s*([A-Za-z0-9._-]+)\/([A-Za-z0-9._/-]+)@([^\s#]+)/g;
const SHA = /^[0-9a-f]{40}$/;

interface Ref { file: string; owner: string; repo: string; ref: string }

const refs: Ref[] = [];
for (const f of files) {
  const src = readFileSync(join(WF_DIR, f), 'utf8');
  for (const m of src.matchAll(USES)) {
    refs.push({ file: f, owner: m[1], repo: m[2], ref: m[3] });
  }
}

describe('сторонние экшены пришпилены к хешу', () => {
  it('ссылки на экшены в репозитории вообще есть', () => {
    // Пустой корпус сделал бы сторож зелёным и бессмысленным (§4.0).
    expect(refs.length).toBeGreaterThan(0);
  });

  it('ни один сторонний экшен не взят по подвижной ссылке', () => {
    const offenders = refs
      .filter((r) => r.owner !== 'actions' && r.owner !== 'github')
      .filter((r) => !SHA.test(r.ref))
      .map((r) => `${r.file}: ${r.owner}/${r.repo}@${r.ref}`);
    expect(
      offenders,
      `сторонний экшен по тегу или ветке (тег переставляет его владелец): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('у каждого пина рядом написано, чем этот хеш был', () => {
    // Голый хеш без пометки нечитаем: по нему не видно ни версии, ни того,
    // когда его брали, и обновлять такой пин никто не станет.
    const unlabeled = files.filter((f) => {
      const src = readFileSync(join(WF_DIR, f), 'utf8');
      return src.split('\n').some((l) =>
        /uses:\s*[^\s#]+@[0-9a-f]{40}/.test(l) && !/#/.test(l));
    });
    expect(unlabeled, `пин без пометки о версии: ${unlabeled.join(', ')}`).toEqual([]);
  });
});
