/**
 * Файл на ревью не может оказаться вне репозитория.
 *
 * CodeQL 143 («File data in outbound network request») привёл к разбору
 * цепочки: пути файлов для Growth Scan приходят из ответов GitHub API
 * (список коммитов, дерево репозитория) — внешние данные, — а строковый
 * фильтр isReviewableSourcePath их не сдерживал: `lib/../../x.ts`
 * начинается с `lib/`, кончается `.ts` — и path.join выходит за корень.
 * Прочитанное тело уезжает в зарубежный LLM. Эксплуатацию сдерживал только
 * запрет `..` в путях git-дерева — чужая гарантия, не наша.
 *
 * Барьер стоит в точке чтения (containedReviewPath) и не доверяет
 * вызывающему — четвёртый случай за 25.07.2026, когда защита существовала,
 * но не там, где происходит действие.
 */
import { describe, it, expect } from 'vitest';
import { containedReviewPath, isReviewableSourcePath } from '@/lib/agents/evo/growth-agent';
import * as path from 'path';

const ROOT = '/srv/app';

const contained = (p: string) => containedReviewPath(p, ROOT, path);

describe('барьер пути в точке чтения файла на ревью', () => {
  it('честный путь репозитория проходит и резолвится внутрь корня', () => {
    expect(contained('lib/eco/ledger.ts')).toBe('/srv/app/lib/eco/ledger.ts');
    expect(contained('app/api/eco/wallet/route.ts')).toBe('/srv/app/app/api/eco/wallet/route.ts');
  });

  it('дыра строкового фильтра закрыта: lib/../../x.ts не проходит', () => {
    // Именно этот вход проходил isReviewableSourcePath и выходил за корень.
    expect(isReviewableSourcePath('lib/../../evil.ts')).toBe(true);
    expect(contained('lib/../../evil.ts')).toBeNull();
  });

  it('любые сегменты .. и . отвергаются — это защищает и URL-фоллбэк', () => {
    // На raw.githubusercontent нормализация URL схлопнула бы `..` и вывела
    // запрос за пределы репозитория — файловым резолвом это не поймать.
    expect(contained('lib/./a.ts')).toBeNull();
    expect(contained('lib/a/../b.ts')).toBeNull();
    expect(contained('lib//a.ts')).toBeNull();
  });

  it('абсолютные пути и обратные слэши отвергаются', () => {
    expect(contained('/etc/passwd.ts')).toBeNull();
    expect(contained('lib\\..\\..\\evil.ts')).toBeNull();
  });

  it('точка чтения не доверяет вызывающему: нефильтрованный путь отвергается', () => {
    // Даже если составитель списка забыл isReviewableSourcePath —
    // барьер применяет его сам.
    expect(contained('scripts/deploy.ts')).toBeNull();
    expect(contained('lib/x.test.ts')).toBeNull();
    expect(contained('.env.local')).toBeNull();
  });
});
