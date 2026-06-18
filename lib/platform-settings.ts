import { pool } from '@/lib/db-pool';

export async function getSetting(key: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ value: string }>(
      'SELECT value FROM platform_settings WHERE key = $1',
      [key],
    );
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}
