import { Api, TelegramClient } from 'telegram';
import { query } from '../db/index.js';
import checkDiskSpaceModule from 'check-disk-space';
import os from 'os';
import fs from 'fs';
import { formatBytes, getTypeEmoji } from '../utils/telegramUtils.js';
import {
    MSG,
    buildWelcomeBack,
    buildHelp,
    buildStorageReport,
    buildFileList,
    buildTasksReport,
    buildDeleteSuccess,
} from '../utils/telegramMessages.js';
import { authenticatedUsers, passwordInputState, isAuthenticated } from './telegramState.js';
import { forceStopDownloadTasks, getDownloadQueueStats, getTaskStatus } from './telegramUpload.js';
import { storageManager } from './storage.js';
import { getSetting, setSetting } from '../utils/settings.js';
import { DuplicateMode, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { startPeriodicCleanup, stopPeriodicCleanup } from './orphanCleanup.js';
import { safeUnlink } from '../utils/localPath.js';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;
const DOWNLOAD_WORKER_OPTIONS = [4, 8, 12, 16];
const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || './data/thumbnails';

function normalizeDownloadWorkers(value: unknown): number {
    const parsed = parseInt(String(value ?? '4'), 10);
    return DOWNLOAD_WORKER_OPTIONS.includes(parsed) ? parsed : 4;
}

async function getCurrentDownloadWorkers(): Promise<number> {
    const value = await getSetting('telegram_download_workers', process.env.TELEGRAM_DOWNLOAD_WORKERS || '4');
    return normalizeDownloadWorkers(value);
}

function buildDownloadWorkersKeyboard(current: number, confirmValue?: number): Api.ReplyInlineMarkup {
    if (confirmValue) {
        return new Api.ReplyInlineMarkup({
            rows: [
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: `⚠️ 确认使用 ${confirmValue}`, data: Buffer.from(`dw_confirm_${confirmValue}`) }),
                        new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('dw_cancel') }),
                    ],
                }),
            ],
        });
    }

    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 4 ? '✅ ' : ''}4`, data: Buffer.from('dw_set_4') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 8 ? '✅ ' : ''}8`, data: Buffer.from('dw_set_8') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 12 ? '✅ ' : ''}12 ⚠️`, data: Buffer.from('dw_set_12') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 16 ? '✅ ' : ''}16 ⚠️`, data: Buffer.from('dw_set_16') }),
                ],
            }),
        ],
    });
}

function buildDownloadWorkersText(current: number): string {
    return [
        '⚙️ **Telegram 并发下载设置**',
        '',
        `当前 worker 数：**${current}**`,
        '',
        '说明：Telegram 单次请求上限仍是 512KB，这里调整的是并发分片数量。',
        '',
        '建议：',
        '- `4`：稳定优先',
        '- `8`：速度/稳定平衡',
        '- `12` / `16`：激进模式，可能触发风控、断流、限速，甚至账号风险，需要二次确认',
    ].join('\n');
}

function isOn(value: unknown, defaultValue = true): boolean {
    if (value === undefined || value === null || value === '') return defaultValue;
    return ON_VALUES.has(String(value).toLowerCase());
}

async function getPathRuleSettings(): Promise<{ bySource: boolean; byType: boolean }> {
    const bySource = await getSetting('storage_path_by_source', process.env.STORAGE_PATH_BY_SOURCE || 'true');
    const byType = await getSetting('storage_path_by_type', process.env.STORAGE_PATH_BY_TYPE || 'true');
    return { bySource: isOn(bySource), byType: isOn(byType) };
}

function buildPathRulesKeyboard(rules: { bySource: boolean; byType: boolean }): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${rules.bySource ? '✅' : '⬜'} 按来源/频道`, data: Buffer.from('pr_toggle_source') }),
                    new Api.KeyboardButtonCallback({ text: `${rules.byType ? '✅' : '⬜'} 按类型`, data: Buffer.from('pr_toggle_type') }),
                ],
            }),
        ],
    });
}

function buildPathRulesText(rules: { bySource: boolean; byType: boolean }): string {
    const example = [rules.bySource ? 'telegram/资源下载' : null, rules.byType ? 'archives' : null].filter(Boolean).join('/') || '文件名直接保存';
    return [
        '📁 **保存路径规则**',
        '',
        `按来源/频道：${rules.bySource ? '✅ 开启' : '⬜ 关闭'}`,
        `按文件类型：${rules.byType ? '✅ 开启' : '⬜ 关闭'}`,
        '',
        `示例：${example}`,
        '',
        '说明：修改后只影响后续新上传/转存文件。',
    ].join('\n');
}

function buildDuplicateModeKeyboard(mode: DuplicateMode): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${mode === 'skip' ? '✅' : '⬜'} 跳过重复`, data: Buffer.from('dm_set_skip') }),
                    new Api.KeyboardButtonCallback({ text: `${mode === 'copy' ? '✅' : '⬜'} 生成副本`, data: Buffer.from('dm_set_copy') }),
                ],
            }),
        ],
    });
}

function buildDuplicateModeText(mode: DuplicateMode): string {
    return [
        '🧬 **重复文件处理**',
        '',
        `当前模式：${mode === 'skip' ? '跳过重复' : '生成副本'}`,
        '',
        '- 跳过重复：同名 + 同目录 + 同大小时不再保存',
        '- 生成副本：自动改名为 `文件 (1).ext` 保留副本',
        '',
        '说明：修改后只影响后续新上传/转存文件。',
    ].join('\n');
}

async function getCleanupEnabledSetting(): Promise<boolean> {
    const value = await getSetting('auto_cleanup_orphans', process.env.AUTO_CLEANUP_ORPHANS || 'true');
    return isOn(value, true);
}

function buildCleanupSettingsKeyboard(enabled: boolean): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${!enabled ? '✅' : '⬜'} 关闭自动清理`, data: Buffer.from('cs_set_off') }),
                    new Api.KeyboardButtonCallback({ text: `${enabled ? '✅' : '⬜'} 开启自动清理`, data: Buffer.from('cs_set_on') }),
                ],
            }),
        ],
    });
}

function buildCleanupSettingsText(enabled: boolean): string {
    return [
        '🧹 **自动清理设置**',
        '',
        `当前状态：${enabled ? '✅ 开启' : '⬜ 关闭'}`,
        '',
        '开启后会自动清理本地 uploads 中未登记到数据库的孤儿文件。',
        '如果你主要使用本地存储，建议点“关闭自动清理”，防止默认删除文件。',
        '',
        '说明：只影响本地 uploads 孤儿文件，不会主动清理第三方云存储。',
    ].join('\n');
}

export async function handleStart(message: Api.Message, senderId: number): Promise<void> {
    if (isAuthenticated(senderId)) {
        await message.reply({ message: buildWelcomeBack() });
    } else {
        passwordInputState.set(senderId, { password: '' });
    }
}

export async function handleHelp(message: Api.Message): Promise<void> {
    await message.reply({ message: buildHelp() });
}

export async function handleStorage(message: Api.Message): Promise<void> {
    try {
        const activeAccountId = storageManager.getActiveAccountId();
        const diskPath = os.platform() === 'win32' ? 'C:' : '/';
        const diskSpace = await checkDiskSpace(diskPath);

        // Fetch stats for the active account
        const result = await query(`
            SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size 
            FROM files 
            WHERE storage_account_id IS NOT DISTINCT FROM $1
        `, [activeAccountId]);
        const flcloudsStats = result.rows[0];
        const totalSize = parseInt(flcloudsStats.total_size);
        const fileCount = parseInt(flcloudsStats.file_count);
        const usedPercent = Math.round(((diskSpace.size - diskSpace.free) / diskSpace.size) * 100);

        const queueStats = getDownloadQueueStats();

        const reply = buildStorageReport({
            diskTotal: diskSpace.size,
            diskFree: diskSpace.free,
            diskUsedPercent: usedPercent,
            fileCount,
            totalFileSize: totalSize,
            queueActive: queueStats.active,
            queuePending: queueStats.pending,
        });

        await message.reply({ message: reply });
    } catch (error) {
        console.error('🤖 获取存储统计失败:', error);
        await message.reply({ message: MSG.ERR_STORAGE });
    }
}

export async function handleList(message: Api.Message, args: string[]): Promise<void> {
    try {
        let limit = 10;
        let page = 1;
        if (args.length > 0) {
            const parsed = parseInt(args[0]);
            if (!isNaN(parsed) && parsed > 0 && parsed <= 50) {
                limit = parsed;
            }
        }
        if (args.length > 1) {
            const parsedPage = parseInt(args[1]);
            if (!isNaN(parsedPage) && parsedPage > 0) {
                page = parsedPage;
            }
        }

        const activeAccountId = storageManager.getActiveAccountId();
        const offset = (page - 1) * limit;
        const result = await query(`
            SELECT id, name, type, size, folder, created_at 
            FROM files 
            WHERE storage_account_id IS NOT DISTINCT FROM $3
            ORDER BY created_at DESC 
            LIMIT $1 OFFSET $2
        `, [limit, offset, activeAccountId]);

        if (result.rows.length === 0) {
            await message.reply({ message: MSG.EMPTY_FILES });
            return;
        }

        const reply = buildFileList(result.rows, result.rows.length);
        await message.reply({ message: reply });
    } catch (error) {
        console.error('🤖 获取文件列表失败:', error);
        await message.reply({ message: MSG.ERR_FILE_LIST });
    }
}

export async function handleDelete(message: Api.Message, args: string[]): Promise<void> {
    if (args.length === 0) {
        await message.reply({
            message: '❌ 请提供要删除的文件\n\n用法：\n/delete <列表序号>  例如 /delete 1\n/delete <ID前缀>  例如 /delete a1b2c3d4\n\n提示：先发送 /list 查看文件 ID 和序号。'
        });
        return;
    }

    const selector = args[0].trim();

    try {
        const activeAccountId = storageManager.getActiveAccountId();
        let result;
        if (/^\d+$/.test(selector) && Number(selector) >= 1 && Number(selector) <= 50) {
            result = await query(`
                SELECT id, name, path, thumbnail_path, source, storage_account_id
                FROM files
                WHERE storage_account_id IS NOT DISTINCT FROM $2
                ORDER BY created_at DESC
                LIMIT 1 OFFSET $1
            `, [Number(selector) - 1, activeAccountId]);
        } else {
            if (selector.length < 4) {
                await message.reply({ message: '❌ ID 前缀至少需要 4 位。也可以用 /delete 1 删除 /list 中第 1 个文件。' });
                return;
            }
            result = await query(`
                SELECT id, name, path, thumbnail_path, source, storage_account_id
                FROM files
                WHERE id::text LIKE $1 AND storage_account_id IS NOT DISTINCT FROM $2
                LIMIT 1
            `, [selector + '%', activeAccountId]);
        }

        if (result.rows.length === 0) {
            await message.reply({ message: /^\d+$/.test(selector) ? `❌ 未找到列表序号 ${selector} 对应的文件` : `❌ 未找到 ID 以 "${selector}" 开头的文件` });
            return;
        }

        const file = result.rows[0];

        // 删除实际文件
        const cloudSources = ['onedrive', 'aliyun_oss', 's3', 'webdav', 'google_drive'];
        if (cloudSources.includes(file.source)) {
            try {
                const provider = storageManager.getProvider(`${file.source}:${file.storage_account_id}`);
                await provider.deleteFile(file.path);
            } catch (err) {
                console.warn(`🤖 ${file.source} 文件物理删除失败或文件已不存在:`, err);
            }
        } else if (file.path) {
            await safeUnlink(file.path, UPLOAD_DIR);
        }

        // 删除缩略图
        if (file.thumbnail_path) {
            await safeUnlink(file.thumbnail_path, THUMBNAIL_DIR);
        }

        // 从数据库删除记录
        await query(`DELETE FROM files WHERE id = $1`, [file.id]);

        await message.reply({ message: buildDeleteSuccess(file.name, file.id) });
    } catch (error) {
        console.error('🤖 删除文件失败:', error);
        await message.reply({ message: `${MSG.ERR_DELETE}: ${(error as Error).message}` });
    }
}

export async function handleTasks(message: Api.Message): Promise<void> {
    try {
        const status = getTaskStatus();
        const activeCount = status.active.length;
        const pendingCount = status.pending.length;
        const historyCount = status.history.length;

        if (activeCount === 0 && pendingCount === 0 && historyCount === 0) {
            await message.reply({ message: MSG.EMPTY_TASKS });
            return;
        }

        const reply = buildTasksReport(status.active, status.pending, status.history);
        await message.reply({ message: reply });

    } catch (error) {
        console.error('🤖 获取任务列表失败:', error);
        await message.reply({ message: MSG.ERR_TASKS });
    }
}

export async function handleStopTasks(message: Api.Message): Promise<void> {
    try {
        const result = forceStopDownloadTasks('用户通过 /stop_tasks 强制停止');
        if (result.total === 0) {
            await message.reply({ message: '📮 当前没有可停止的下载任务' });
            return;
        }

        await message.reply({
            message: `🛑 已发送停止指令\n\n处理中: ${result.active}\n等待中: ${result.pending}\n\n正在下载的任务会在当前分片结束后停止，并自动清理临时文件。`
        });
    } catch (error) {
        console.error('🤖 强制停止任务失败:', error);
        await message.reply({ message: `❌ 强制停止任务失败: ${(error as Error).message}` });
    }
}

export async function handleDownloadWorkers(message: Api.Message): Promise<void> {
    try {
        const current = await getCurrentDownloadWorkers();
        await message.reply({
            message: buildDownloadWorkersText(current),
            buttons: buildDownloadWorkersKeyboard(current),
        });
    } catch (error) {
        console.error('🤖 获取并发下载设置失败:', error);
        await message.reply({ message: `❌ 获取并发下载设置失败: ${(error as Error).message}` });
    }
}

export async function handlePathRules(message: Api.Message): Promise<void> {
    const rules = await getPathRuleSettings();
    await message.reply({
        message: buildPathRulesText(rules),
        buttons: buildPathRulesKeyboard(rules),
    });
}

export async function handlePathRulesCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!isAuthenticated(userId)) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const rules = await getPathRuleSettings();
        if (data === 'pr_toggle_source') {
            rules.bySource = !rules.bySource;
            await setSetting('storage_path_by_source', String(rules.bySource));
        } else if (data === 'pr_toggle_type') {
            rules.byType = !rules.byType;
            await setSetting('storage_path_by_type', String(rules.byType));
        }

        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildPathRulesText(rules),
            buttons: buildPathRulesKeyboard(rules),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '保存路径规则已更新' }));
    } catch (error) {
        console.error('🤖 设置保存路径规则失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `设置失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleDuplicateMode(message: Api.Message): Promise<void> {
    const mode = await getDuplicateMode();
    await message.reply({
        message: buildDuplicateModeText(mode),
        buttons: buildDuplicateModeKeyboard(mode),
    });
}

export async function handleDuplicateModeCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!isAuthenticated(userId)) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const match = data.match(/^dm_set_(skip|copy)$/);
        if (!match) return;
        const mode = match[1] as DuplicateMode;
        await setSetting('duplicate_file_mode', mode);
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildDuplicateModeText(mode),
            buttons: buildDuplicateModeKeyboard(mode),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已设置为${mode === 'skip' ? '跳过重复' : '生成副本'}` }));
    } catch (error) {
        console.error('🤖 设置重复文件处理失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `设置失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleCleanupSettings(message: Api.Message): Promise<void> {
    const enabled = await getCleanupEnabledSetting();
    await message.reply({
        message: buildCleanupSettingsText(enabled),
        buttons: buildCleanupSettingsKeyboard(enabled),
    });
}

export async function handleCleanupSettingsCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!isAuthenticated(userId)) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const enabled = data === 'cs_set_on';
        await setSetting('auto_cleanup_orphans', String(enabled));
        process.env.AUTO_CLEANUP_ORPHANS = String(enabled);
        if (enabled) {
            startPeriodicCleanup();
        } else {
            stopPeriodicCleanup();
        }
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildCleanupSettingsText(enabled),
            buttons: buildCleanupSettingsKeyboard(enabled),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: enabled ? '已开启自动清理' : '已关闭自动清理' }));
    } catch (error) {
        console.error('🤖 设置自动清理失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `设置失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleDownloadWorkersCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!isAuthenticated(userId)) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: MSG.AUTH_REQUIRED,
            alert: true,
        }));
        return;
    }

    try {
        if (data === 'dw_cancel') {
            const current = await getCurrentDownloadWorkers();
            await client.editMessage(update.peer, {
                message: update.msgId,
                text: buildDownloadWorkersText(current),
                buttons: buildDownloadWorkersKeyboard(current),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
            return;
        }

        const setMatch = data.match(/^dw_set_(4|8|12|16)$/);
        if (setMatch) {
            const workers = Number(setMatch[1]);
            if (workers >= 12) {
                await client.editMessage(update.peer, {
                    message: update.msgId,
                    text: [
                        `⚠️ **确认使用 ${workers} workers？**`,
                        '',
                        '这是激进并发模式，可能出现：',
                        '- Telegram 风控或限流',
                        '- 下载断流 / 重试增多',
                        '- user session 账号风险，极端情况下可能影响账号',
                        '',
                        '如果只是日常下载，建议使用 4 或 8。',
                    ].join('\n'),
                    buttons: buildDownloadWorkersKeyboard(workers, workers),
                });
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '需要二次确认' }));
                return;
            }

            await setSetting('telegram_download_workers', String(workers));
            await client.editMessage(update.peer, {
                message: update.msgId,
                text: `${buildDownloadWorkersText(workers)}\n\n✅ 已切换为 ${workers} workers，后续新下载任务立即生效。`,
                buttons: buildDownloadWorkersKeyboard(workers),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已设置为 ${workers}` }));
            return;
        }

        const confirmMatch = data.match(/^dw_confirm_(12|16)$/);
        if (confirmMatch) {
            const workers = Number(confirmMatch[1]);
            await setSetting('telegram_download_workers', String(workers));
            await client.editMessage(update.peer, {
                message: update.msgId,
                text: `${buildDownloadWorkersText(workers)}\n\n⚠️ 已确认并切换为 ${workers} workers。若出现断流、限速、风控提示，请立即降回 4 或 8。`,
                buttons: buildDownloadWorkersKeyboard(workers),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已确认 ${workers} workers`, alert: true }));
        }
    } catch (error) {
        console.error('🤖 设置并发下载 worker 失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `设置失败: ${(error as Error).message}`,
            alert: true,
        }));
    }
}
