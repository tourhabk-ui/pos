import { pool } from '@/lib/db-pool';
import { getGeminiKey } from '@/lib/ai/provider-config';

export interface PhotoAuditResult {
  imageId: string;
  placeName: string;
  matches: boolean;
  reason: string;
}

interface ImageRow {
  id: string;
  route_id: string;
  image_data: Buffer;
  mime_type: string;
  place_name: string;
  location_type: string | null;
  description: string | null;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

function isGeminiResponse(value: unknown): value is GeminiResponse {
  return typeof value === 'object' && value !== null && 'candidates' in value;
}

async function callGeminiVision(
  apiKey: string,
  placeName: string,
  locationType: string,
  imageBase64: string,
  mimeType: string,
): Promise<{ matches: boolean; reason: string }> {
  const prompt = `Does this image show or represent '${placeName}', a ${locationType} located in Kamchatka, Russia? Answer with YES or NO on the first line, then one sentence explaining why.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 100, temperature: 0 },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const raw: unknown = await response.json();

  if (!isGeminiResponse(raw)) {
    throw new Error('Unexpected Gemini response shape');
  }

  const text = raw.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const lines = text.trim().split('\n');
  const firstLine = (lines[0] ?? '').trim().toUpperCase();
  const matches = firstLine.startsWith('YES');
  const reason = lines.slice(1).join(' ').trim() || text.trim();

  return { matches, reason };
}

export async function auditPhotoBatch(
  batchSize = 20,
): Promise<{ audited: number; rejected: number; errors: number }> {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    return { audited: 0, rejected: 0, errors: 0 };
  }

  const { rows } = await pool.query<ImageRow>(
    `SELECT
       ari.id,
       ari.route_id,
       ari.image_data,
       ari.mime_type,
       p.name         AS place_name,
       p.location_type,
       p.description
     FROM ai_route_images ari
     JOIN places p ON p.ark_id = ari.route_id
     WHERE ari.photo_verified IS NULL
     LIMIT $1`,
    [batchSize],
  );

  let audited = 0;
  let rejected = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const imageBase64 = Buffer.isBuffer(row.image_data)
        ? row.image_data.toString('base64')
        : Buffer.from(row.image_data as unknown as string, 'hex').toString('base64');

      const locationType = row.location_type ?? 'natural landmark';
      const mimeType = row.mime_type ?? 'image/jpeg';

      const { matches, reason } = await callGeminiVision(
        apiKey,
        row.place_name,
        locationType,
        imageBase64,
        mimeType,
      );

      await pool.query(
        `UPDATE ai_route_images
         SET photo_verified  = $1,
             ai_audit_reason = $2,
             ai_audit_at     = NOW()
         WHERE id = $3`,
        [matches, reason, row.id],
      );

      audited++;
      if (!matches) rejected++;
    } catch {
      errors++;
    }
  }

  return { audited, rejected, errors };
}
