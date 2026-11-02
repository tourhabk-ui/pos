export interface AgentTourCheck { check: string; ok: boolean; detail?: string }
export function checkAgentTourHtml(
  html: string,
  opts: { slug: string; date: string; guests: number; base?: string },
): AgentTourCheck[];
