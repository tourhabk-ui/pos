import { describe, expect, it } from 'vitest';
import { TOOL_ENGLISH } from '@/lib/mcp/public-tools';

describe('get_place_info не обещает то, чего не отдаёт', () => {
  it('лид — факты места, не опасности и не соседи', () => {
    const lead = TOOL_ENGLISH.get_place_info.lead;
    expect(lead).toMatch(/type, coordinates/);
    expect(lead).toMatch(/get_guardian_context/);
    expect(lead).not.toMatch(/hazards, nearby places/);
    expect(lead).toMatch(/Does not return hazards/);
  });
});
