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

/**
 * 按 Telegram 消息链接查找已存在的文件。
 * 消息链接（频道/超级群 + 消息 id）唯一标识一条消息的内容，是最可靠的去重键。
 * 无论 duplicate_file_mode 是 copy 还是 skip，只要同一条消息已入库就应跳过重复下载，
 * 以避免订阅同步的媒体组重复展开、失败未推进游标等场景产生 " (2)"、" (3)" 后缀副本。
 * 仅对能解析出链接的频道/超级群生效；私聊转发无链接时返回 null，走原有逻辑。
 */
export async function findFileByTelegramMessageLink(link: string | null | undefined) {
    if (!link) return null;
    const result = await query(
        `SELECT id, name, stored_name, folder, size, created_at, telegram_message_link, telegram_source_name
         FROM files
         WHERE telegram_message_link = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [link]
    );
    return result.rows[0] || null;
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
