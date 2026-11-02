import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  apiRoutesFromFiles, endpointExists, extractApiEndpoints, validateProposalPaths, loadRepoFiles, normalizePath,
} from '@/lib/agents/scout-path-guard';

const FILES = [
  'app/api/admin/agents/trigger/route.ts',
  'app/api/tours/[id]/route.ts',
  'app/api/docs/[...slug]/route.ts',
  'lib/agents/platform-week-stats.ts',
  'lib/agents/scout-innovator.ts',
  'lib/offline/region-pack.ts',
];

const base = {
  title: 'Улучшение', why: 'триггер: 0 маршрутов', implementation_steps: ['1. правка'], acceptance_criteria: ['тест'],
};

describe('scout-path-guard', () => {
  it('строит роуты из файлов', () => {
    expect(apiRoutesFromFiles(FILES)).toEqual(['/api/admin/agents/trigger', '/api/docs/[...slug]', '/api/tours/[id]']);
  });

  it('сверяет эндпоинты с динамическими сегментами', () => {
    const r = apiRoutesFromFiles(FILES);
    expect(endpointExists('/api/tours/123', r)).toBe(true);
    expect(endpointExists('/api/docs/a/b', r)).toBe(true);
    expect(endpointExists('/api/map/pack', r)).toBe(false);
    expect(endpointExists('/api/admin/stats', r)).toBe(false);
  });

  it('вытаскивает /api/... из текста', () => {
    expect(extractApiEndpoints('вызвать /api/offline/pack. и /api/tours/[id]')).toEqual(['/api/offline/pack', '/api/tours/[id]']);
  });

  it('пропускает предложение с выдуманным файлом (#2904: schema-usage.ts)', () => {
    const r = validateProposalPaths({ ...base, files_to_change: ['lib/agents/schema-usage.ts'] }, FILES);
    expect(r.kind).toBe('skip');
  });

  it('пропускает предложение с выдуманным эндпоинтом (#2898: /api/map/pack)', () => {
    const r = validateProposalPaths({ ...base, why: 'логировать в /api/map/pack', files_to_change: ['lib/offline/region-pack.ts'] }, FILES);
    expect(r).toMatchObject({ kind: 'skip' });
    if (r.kind === 'skip') expect(r.reason).toContain('/api/map/pack');
  });

  it('переписывает путь на единственный реальный файл с тем же именем', () => {
    const r = validateProposalPaths({ ...base, files_to_change: ['lib/stats/platform-week-stats.ts (новый)'] }, FILES);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.proposal.files_to_change).toEqual(['lib/agents/platform-week-stats.ts']);
  });

  it('пропускает чужой route.ts — имя слишком общее для подмены', () => {
    expect(validateProposalPaths({ ...base, files_to_change: ['app/api/map/pack/route.ts'] }, FILES).kind).toBe('skip');
  });

  it('пропускает реальные пути и роуты', () => {
    const r = validateProposalPaths({ ...base, why: 'см. /api/admin/agents/trigger', files_to_change: ['lib/agents/scout-innovator.ts'] }, FILES);
    expect(r.kind).toBe('ok');
  });

  it('normalizePath срезает пометки', () => {
    expect(normalizePath('`./lib/a.ts` ')).toBe('lib/a.ts');
  });

  it('видит реальное дерево репо', async () => {
    const files = await loadRepoFiles();
    expect(files).toContain('lib/agents/scout-innovator.ts');
    expect(apiRoutesFromFiles(files ?? [])).toContain('/api/cron/scout');
  });

  it('промпт и прогон используют сторож, дубли сверяются и с закрытыми', () => {
    const src = readFileSync('lib/agents/scout-innovator.ts', 'utf-8');
    expect(src).toContain('validateProposalPaths(p, repoFiles)');
    expect(src).toContain('...closedTitles');
    expect(src).toContain('копируй ДОСЛОВНО из переданного списка реальных файлов');
  });

  it('манифест доезжает в standalone-образ', () => {
    const df = readFileSync('Dockerfile', 'utf-8');
    expect(df).toContain('RUN node scripts/write-repo-manifest.js');
    expect(df).toContain('/app/repo-manifest.json');
  });
});
