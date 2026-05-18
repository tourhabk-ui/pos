/**
 * Stub HTTP client for the Claude Managed Agents API (public beta).
 * Header: `managed-agents-2026-04-01`
 * When USE_MANAGED_API=true in env, requests go to the real endpoint.
 * Otherwise returns null (feature-flagged off by default).
 */

export interface ManagedAgentRequest {
  model: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  max_tokens?: number;
  metadata?: Record<string, unknown>;
}

export interface ManagedAgentResponse {
  id: string;
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

const MANAGED_API_URL = 'https://api.anthropic.com/v1/messages';
const MANAGED_API_BETA = 'managed-agents-2026-04-01';

export async function callManagedAgent(
  req: ManagedAgentRequest
): Promise<ManagedAgentResponse | null> {
  if (process.env.USE_MANAGED_API !== 'true') return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const res = await fetch(MANAGED_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': MANAGED_API_BETA,
    },
    body: JSON.stringify({ ...req, max_tokens: req.max_tokens ?? 512 }),
  });

  if (!res.ok) return null;
  return res.json() as Promise<ManagedAgentResponse>;
}
