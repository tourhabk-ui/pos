import { readFileSync } from 'fs';
import { join } from 'path';

export function GET() {
  const html = readFileSync(join(process.cwd(), 'public/emergency.html'), 'utf-8');
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
