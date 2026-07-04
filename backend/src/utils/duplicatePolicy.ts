import { query } from '../db/index.js';
import { getSetting } from './settings.js';

export type DuplicateMode = 'copy' | 'skip';

export function normalizeDuplicateMode(value: unknown): DuplicateMode {
    return value === 'skip' ? 'skip' : 'copy';
}

export async function getDuplicateMode(): Promise<DuplicateMode> {
    const value = await getSetting('duplicate_file_mode', process.env.DUPLICATE_FILE_MODE || 'copy');
    return normalizeDuplicateMode(value);
}

export async function findDuplicateFile(name: string, folder: string | null, size: number, storageAccountId: string | null) {
    const result = await query(
        `SELECT id, name, path, folder, size, created_at, telegram_message_link, telegram_source_name
         FROM files
         WHERE name = $1
           AND folder IS NOT DISTINCT FROM $2
           AND size = $3
           AND storage_account_id IS NOT DISTINCT FROM $4
         ORDER BY created_at DESC
         LIMIT 1`,
        [name, folder, size, storageAccountId]
    );
    return result.rows[0] || null;
}
