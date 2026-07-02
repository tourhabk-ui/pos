import { describe, it, expect } from 'vitest';
import { KUZMICH_TOOLS, validateToolArgs } from '@/lib/kuzmich/tool-schemas';

describe('KUZMICH_TOOLS (generated from the registry)', () => {
  it('exposes exactly the 6 known tools with their JSON-schema definitions intact', () => {
    const names = KUZMICH_TOOLS.map(t => t.function.name).sort();
    expect(names).toEqual([
      'get_guardian_context', 'get_place_info', 'get_tours', 'get_weather', 'search_kamchatka', 'search_taaft',
    ]);
  });

  it('keeps get_guardian_context requiring "place" in its API-facing JSON schema', () => {
    const def = KUZMICH_TOOLS.find(t => t.function.name === 'get_guardian_context')!;
    expect(def.function.parameters.required).toEqual(['place']);
  });
});

describe('validateToolArgs', () => {
  it('accepts a valid search_kamchatka call', () => {
    const r = validateToolArgs('search_kamchatka', { query: 'цены на баню в паратунке' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.query).toBe('цены на баню в паратунке');
  });

  it('rejects search_kamchatka missing the required query', () => {
    const r = validateToolArgs('search_kamchatka', {});
    expect(r.ok).toBe(false);
  });

  it('rejects an empty-string query (min length)', () => {
    const r = validateToolArgs('search_kamchatka', { query: '   ' });
    expect(r.ok).toBe(false);
  });

  it('accepts get_tours with no arguments (activity_type is optional)', () => {
    const r = validateToolArgs('get_tours', {});
    expect(r.ok).toBe(true);
  });

  it('accepts get_guardian_context with "place"', () => {
    const r = validateToolArgs('get_guardian_context', { place: 'Толбачик' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.place).toBe('Толбачик');
  });

  it('tolerates get_guardian_context called with "name" instead of "place" (existing executeTool fallback)', () => {
    const r = validateToolArgs('get_guardian_context', { name: 'Толбачик' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.name).toBe('Толбачик');
  });

  it('rejects get_guardian_context with neither place nor name', () => {
    const r = validateToolArgs('get_guardian_context', {});
    expect(r.ok).toBe(false);
  });

  it('requires name for get_place_info', () => {
    expect(validateToolArgs('get_place_info', { name: 'Авачинский вулкан' }).ok).toBe(true);
    expect(validateToolArgs('get_place_info', {}).ok).toBe(false);
  });

  it('accepts get_weather with no arguments and silently drops unexpected extra fields', () => {
    const r = validateToolArgs('get_weather', {});
    expect(r.ok).toBe(true);
    const r2 = validateToolArgs('get_weather', { extra: 'ignored' } as unknown as Record<string, string>);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.args).not.toHaveProperty('extra');
  });

  it('accepts search_taaft with either task or query, rejects neither', () => {
    expect(validateToolArgs('search_taaft', { task: 'определить растение на фото' }).ok).toBe(true);
    expect(validateToolArgs('search_taaft', { query: 'определить растение на фото' }).ok).toBe(true);
    expect(validateToolArgs('search_taaft', {}).ok).toBe(false);
  });

  it('coerces a non-string JSON value (e.g. a number) instead of rejecting it', () => {
    const r = validateToolArgs('search_kamchatka', { query: 12345 as unknown as string });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.query).toBe('12345');
  });

  it('truncates an overly long string to the field maximum instead of rejecting the call', () => {
    const r = validateToolArgs('search_kamchatka', { query: 'a'.repeat(5000) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.query.length).toBe(300);
  });

  it('passes unknown tool names through unchanged (executeTool keeps its own "unknown tool" message)', () => {
    const r = validateToolArgs('not_a_real_tool', { anything: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ anything: 'x' });
  });
});
