import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { Raw } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import { storageManager } from '../services/storage.js';
import { authenticatedUsers, passwordInputState, isAuthenticatedAsync, loadAuthenticatedUsers, persistAuthenticatedUser, userStates, TelegramUserState } from './telegramState.js';
import { is2FAEnabled, generateOTPAuthUrl, verifyTOTP, activate2FA } from '../utils/security.js';
import { handleStart, handleHelp, handleStorage, handleStorageSwitch, handleStorageSwitchCallback, handleDelete, handleDeleteConfirmCallback, handleTasks, handleStopTasks, handlePauseTasks, handleResumeTasks, handleCancelTask, handleChannelTaskQueueCallback, handleRetryFailedTasks, handleDownloadWorkers, handleDownloadWorkersCallback, handleFileConcurrency, handleFileConcurrencyCallback, handleStorageCleanupCallback, handlePathRules, handlePathOnce, handlePathSession, handlePathClear, handlePathRulesCallback, handleDuplicateMode, handleDuplicateModeCallback, handleCleanupSettings, handleCleanupSettingsCallback } from './telegramCommands.js';
import { handleFileUpload, handleCleanupCallback, pauseDownloadTasks, resumeDownloadTasks, resolveTaskChatIdForControl, refreshSilentProgress, cancelSilentTask, canControlTask, loadFileDownloadConcurrencySetting } from './telegramUpload.js';
import { handleYtDlpCommand } from './ytDlpDownload.js';
import {
    enqueueTelegramDateDownload,
    enqueueTelegramTagDownload,
    listTelegramSubscriptions,
    listTelegramDialogs,
    type TelegramJobProgressSummary,
    startTelegramJobRecoveryWorker,
    startTelegramSubscriptionWorker,
    subscribeTelegramChannel,
    unsubscribeTelegramChannel,
    updateTelegramSubscriptionFolder,
    TELEGRAM_COMMENTS_MAX_PER_POST,
} from './telegramChannelJobs.js';
import { cleanupOrphanFiles, isAutoCleanupEnabled, startPeriodicCleanup } from './orphanCleanup.js';
import { MSG, buildStartPrompt, buildAuthSuccess, build2FASetupCaption, buildCleanupNotice } from '../utils/telegramMessages.js';
import { query } from '../db/index.js';
import { getConfiguredTelegramAllowedUsers, verifyTelegramPin } from '../utils/authSettings.js';
import { assertPublicHttpUrl } from '../utils/networkSecurity.js';
import { rememberRecentTelegramPathPersistent, buildPathPreviewLine, applyPendingTelegramPathInputPersistent, getPendingTelegramPathInput, clearPendingTelegramPathInput } from '../utils/telegramPathSettings.js';

// Session File Path
const SESSION_FILE = process.env.TELEGRAM_SESSION_FILE || './data/telegram_session.txt';

// GramJS Client
let client: TelegramClient | null = null;

type TelegramWizardKind = 'tg_sub_manage' | 'tg_download' | 'tg_date' | 'tg_tag';
type TelegramWizardStep = 'mode' | 'source' | 'path' | 'comments' | 'start_date' | 'end_date' | 'tag';

interface TelegramWizardState {
    kind: TelegramWizardKind;
    step: TelegramWizardStep;
    source?: string;
    sources?: string[]; // 批量订阅
    startDate?: string;
    tag?: string;
    customFolder?: string;
    includeComments?: boolean;
    commentsMaxPerPost?: number;
    subscriptionId?: string;
    subscriptionTitle?: string;
    subscriptionSource?: string;
}

function buildTelegramDownloadModeKeyboard(): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '🗓️ 按日期下载', data: Buffer.from('tgd_mode_date') }),
                    new Api.KeyboardButtonCallback({ text: '🏷️ 按标签下载', data: Buffer.from('tgd_mode_tag') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('tgd_cancel') })],
            }),
        ],
    });
}

function buildTelegramCommentsKeyboard(): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '仅频道正文', data: Buffer.from('tgd_comments_off') }),
                    new Api.KeyboardButtonCallback({ text: '频道 + 评论区', data: Buffer.from('tgd_comments_on') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('tgd_cancel') })],
            }),
        ],
    });
}

// ===== 主菜单 / 设置面板 / 快捷键盘 UX =====

// 常驻快捷回复键盘的按钮文案（点击后作为普通消息发送，需在消息处理器中拦截）
const QUICK_ACTIONS = {
    subscribe: '📡 订阅频道',
    download: '📦 下载频道',
    tasks: '🔧 任务队列',
    menu: '🏠 主菜单',
} as const;
const QUICK_ACTION_VALUES = new Set<string>(Object.values(QUICK_ACTIONS));

function buildQuickActionKeyboard(): Api.ReplyKeyboardMarkup {
    return new Api.ReplyKeyboardMarkup({
        resize: true,
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButton({ text: QUICK_ACTIONS.subscribe }),
                    new Api.KeyboardButton({ text: QUICK_ACTIONS.download }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButton({ text: QUICK_ACTIONS.tasks }),
                    new Api.KeyboardButton({ text: QUICK_ACTIONS.menu }),
                ],
            }),
        ],
    });
}

function buildMainMenu(): { text: string; buttons: Api.ReplyInlineMarkup } {
    return {
        text: [
            '📂 **TG Vault 控制台**',
            '',
            '点击下方按钮即可操作，无需记忆命令。',
            '也可直接发送 / 转发文件进行上传。',
        ].join('\n'),
        buttons: new Api.ReplyInlineMarkup({
            rows: [
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: '📡 订阅频道', data: Buffer.from('menu_sub') }),
                        new Api.KeyboardButtonCallback({ text: '📦 下载频道', data: Buffer.from('menu_download') }),
                    ],
                }),
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: '🔧 任务队列', data: Buffer.from('menu_tasks') }),
                        new Api.KeyboardButtonCallback({ text: '💾 存储', data: Buffer.from('menu_storage') }),
                    ],
                }),
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: '⚙️ 设置', data: Buffer.from('menu_settings') }),
                        new Api.KeyboardButtonCallback({ text: '❓ 帮助', data: Buffer.from('menu_help') }),
                    ],
                }),
            ],
        }),
    };
}

function buildSettingsMenu(): { text: string; buttons: Api.ReplyInlineMarkup } {
    return {
        text: [
            '⚙️ **设置**',
            '',
            '点击任意项进行调整，每项都会显示当前值。',
        ].join('\n'),
        buttons: new Api.ReplyInlineMarkup({
            rows: [
                new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '⚡ 单文件分片并发', data: Buffer.from('set_workers') })] }),
                new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '📦 同时下载文件数', data: Buffer.from('set_files') })] }),
                new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '🧬 重复文件处理', data: Buffer.from('set_dup') })] }),
                new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '🧹 自动清理设置', data: Buffer.from('set_cleanup') })] }),
                new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '📁 保存路径规则', data: Buffer.from('set_path') })] }),
                new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '💾 切换存储源', data: Buffer.from('set_storage') })] }),
                new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '🏠 返回主菜单', data: Buffer.from('menu_home') })] }),
            ],
        }),
    };
}

// 从回调查询构造一个最小的“消息代理”，让复用命令处理器（依赖 message.reply / senderId / chatId）在按钮场景下也能工作。
function callbackMessageProxy(activeClient: TelegramClient, update: Api.UpdateBotCallbackQuery): any {
    const entity = update.userId;
    return {
        chatId: update.userId,
        senderId: update.userId,
        reply: (params: any) => activeClient.sendMessage(entity, params),
    };
}

async function handleMainMenuCallback(activeClient: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await activeClient.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const proxy = callbackMessageProxy(activeClient, update);
    const ack = (msg?: string) => activeClient.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, ...(msg ? { message: msg } : {}) }));

    if (data === 'menu_home') {
        const menu = buildMainMenu();
        await activeClient.editMessage(update.peer, { message: update.msgId, text: menu.text, buttons: menu.buttons });
        await ack();
        return;
    }
    if (data === 'menu_settings') {
        const settings = buildSettingsMenu();
        await activeClient.editMessage(update.peer, { message: update.msgId, text: settings.text, buttons: settings.buttons });
        await ack();
        return;
    }
    if (data === 'menu_sub') { await ack('打开订阅管理'); await startTelegramWizard(proxy, userId, 'tg_sub_manage'); return; }
    if (data === 'menu_download') { await ack('打开频道下载'); await startTelegramWizard(proxy, userId, 'tg_download'); return; }
    if (data === 'menu_tasks') { await ack(); await handleTasks(proxy); return; }
    if (data === 'menu_storage') { await ack(); await handleStorage(proxy); return; }
    if (data === 'menu_help') { await ack(); await handleHelp(proxy); return; }
}

async function handleSettingsMenuCallback(activeClient: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await activeClient.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const proxy = callbackMessageProxy(activeClient, update);
    await activeClient.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
    switch (data) {
        case 'set_workers': await handleDownloadWorkers(proxy); return;
        case 'set_files': await handleFileConcurrency(proxy); return;
        case 'set_dup': await handleDuplicateMode(proxy); return;
        case 'set_cleanup': await handleCleanupSettings(proxy); return;
        case 'set_path': await handlePathRules(proxy); return;
        case 'set_storage': await handleStorageSwitch(proxy); return;
    }
}

// 保存目录步骤的按钮：让用户无需输入文字即可继续（使用默认目录）或取消
function buildPathStepKeyboard(): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '📁 使用默认目录', data: Buffer.from('tgw_path_skip') })] }),
            new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '❌ 取消', data: Buffer.from('tgw_cancel') })] }),
        ],
    });
}

// 仅含取消的按钮：用于需要文字输入的步骤（频道、标签、日期），确保无需再靠文字“取消”退出
function buildWizardCancelKeyboard(): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '❌ 取消', data: Buffer.from('tgw_cancel') })] })],
    });
}

// 根据向导当前步骤返回合适的按钮，保证每一步都能通过按钮操作/退出
function wizardStepButtons(state: TelegramWizardState): Api.ReplyInlineMarkup {
    switch (state.step) {
        case 'mode': return buildTelegramDownloadModeKeyboard();
        case 'comments': return buildTelegramCommentsKeyboard();
        case 'path': return buildPathStepKeyboard();
        default: return buildWizardCancelKeyboard(); // source / tag / start_date / end_date
    }
}

async function handleWizardCallback(activeClient: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await activeClient.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    if (data === 'tgw_cancel') {
        telegramWizardStates.delete(userId);
        await activeClient.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
        await activeClient.sendMessage(update.userId, { message: '已取消当前操作。' });
        return;
    }
    if (data === 'tgw_path_skip') {
        const state = telegramWizardStates.get(userId);
        if (!state || state.step !== 'path') {
            await activeClient.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '该步骤已结束', alert: true }));
            return;
        }
        await activeClient.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '使用默认目录' }));
        // 复用文字流程：等价于用户发送“跳过”
        await handleTelegramWizardMessage(callbackMessageProxy(activeClient, update), userId, '跳过');
        return;
    }
}

const telegramWizardStates = new Map<number, TelegramWizardState>();

// 频道/群组选择器状态（批量勾选）
const pickerSelections = new Map<number, Set<string>>();

function getPickerSelections(userId: number): Set<string> {
    let s = pickerSelections.get(userId);
    if (!s) { s = new Set(); pickerSelections.set(userId, s); }
    return s;
}

function clearPickerSelections(userId: number): void {
    pickerSelections.delete(userId);
}

interface RateBucket {
    windowStartedAt: number;
    count: number;
}

const telegramRateBuckets = new Map<string, RateBucket>();
const TELEGRAM_MESSAGE_RATE_WINDOW_MS = Math.max(10_000, parseInt(process.env.TELEGRAM_RATE_WINDOW_MS || '60000', 10) || 60_000);
const TELEGRAM_MESSAGE_RATE_MAX = Math.max(5, parseInt(process.env.TELEGRAM_RATE_MAX || '30', 10) || 30);
const TELEGRAM_HEAVY_RATE_WINDOW_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_HEAVY_RATE_WINDOW_MS || '600000', 10) || 600_000);
const TELEGRAM_HEAVY_RATE_MAX = Math.max(1, parseInt(process.env.TELEGRAM_HEAVY_RATE_MAX || '5', 10) || 5);
const TELEGRAM_HEAVY_COMMANDS = new Set(['/ytdlp', '/tg_download', '/tg_date', '/tg_tag', '/cleanup_settings']);

interface PinFailureState {
    windowStartedAt: number;
    failed: number;
    lockedUntil?: number;
}

const pinFailureState = new Map<number, PinFailureState>();
const TELEGRAM_PIN_FAIL_WINDOW_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_PIN_FAIL_WINDOW_MS || '900000', 10) || 900_000);
const TELEGRAM_PIN_FAIL_MAX = Math.max(3, parseInt(process.env.TELEGRAM_PIN_FAIL_MAX || '5', 10) || 5);
const TELEGRAM_PIN_LOCK_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_PIN_LOCK_MS || '900000', 10) || 900_000);
const TELEGRAM_PIN_REQUIRED_LENGTH = 4;

function getPinLockSeconds(userId: number): number {
    const state = pinFailureState.get(userId);
    if (!state?.lockedUntil) return 0;
    const remaining = state.lockedUntil - Date.now();
    if (remaining <= 0) {
        pinFailureState.delete(userId);
        return 0;
    }
    return Math.ceil(remaining / 1000);
}

function recordPinFailure(userId: number): { locked: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const current = pinFailureState.get(userId);
    const state: PinFailureState = !current || now - current.windowStartedAt >= TELEGRAM_PIN_FAIL_WINDOW_MS
        ? { windowStartedAt: now, failed: 0 }
        : current;
    state.failed += 1;
    if (state.failed >= TELEGRAM_PIN_FAIL_MAX) {
        state.lockedUntil = now + TELEGRAM_PIN_LOCK_MS;
    }
    pinFailureState.set(userId, state);
    return { locked: Boolean(state.lockedUntil && state.lockedUntil > now), retryAfterSeconds: state.lockedUntil ? Math.ceil((state.lockedUntil - now) / 1000) : 0 };
}

function clearPinFailures(userId: number): void {
    pinFailureState.delete(userId);
}


function consumeTelegramRateLimit(userId: number, text: string): { limited: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const normalized = text.trim().split(/\s+/, 1)[0].replace(/@\w+$/, '').toLowerCase();
    const checks = [
        { key: `${userId}:all`, windowMs: TELEGRAM_MESSAGE_RATE_WINDOW_MS, max: TELEGRAM_MESSAGE_RATE_MAX },
    ];

    if (TELEGRAM_HEAVY_COMMANDS.has(normalized)) {
        checks.push({ key: `${userId}:heavy:${normalized}`, windowMs: TELEGRAM_HEAVY_RATE_WINDOW_MS, max: TELEGRAM_HEAVY_RATE_MAX });
    }

    let longestRetryAfter = 0;
    for (const check of checks) {
        const bucket = telegramRateBuckets.get(check.key);
        if (!bucket || now - bucket.windowStartedAt >= check.windowMs) {
            telegramRateBuckets.set(check.key, { windowStartedAt: now, count: 1 });
            continue;
        }
        if (bucket.count >= check.max) {
            longestRetryAfter = Math.max(longestRetryAfter, Math.ceil((check.windowMs - (now - bucket.windowStartedAt)) / 1000));
            continue;
        }
        bucket.count += 1;
    }

    // Opportunistic cleanup to avoid unbounded growth in long-running bots.
    for (const [key, bucket] of telegramRateBuckets) {
        if (now - bucket.windowStartedAt > Math.max(TELEGRAM_MESSAGE_RATE_WINDOW_MS, TELEGRAM_HEAVY_RATE_WINDOW_MS) * 2) {
            telegramRateBuckets.delete(key);
        }
    }

    return { limited: longestRetryAfter > 0, retryAfterSeconds: longestRetryAfter };
}

function isCancelInput(text: string): boolean {
    return /^(取消|cancel|退出|stop)$/i.test(text.trim());
}

function buildTelegramWizardPrompt(state: TelegramWizardState): string {
    const title = state.kind === 'tg_sub_manage'
        ? '📡 **订阅频道管理**'
        : state.kind === 'tg_tag'
            ? '🏷️ **按标签下载频道文件**'
            : state.kind === 'tg_date'
                ? '🗓️ **按日期下载频道文件**'
                : '📦 **频道文件下载**';

    if (state.step === 'mode') {
        return [
            title,
            '',
            '请选择下载方式：',
            '`日期` — 下载某个日期范围内的频道媒体',
            '`标签` — 下载带指定 #标签 的频道媒体',
            '',
            '也可以直接发送：`date` / `tag`。',
            '点击「❌ 取消」按钮即可退出（也可发送“取消”）。',
        ].join('\n');
    }

    if (state.step === 'source') {
        return [
            title,
            '',
            '请发送频道用户名或链接：',
            '例如：`@channel_username` 或 `https://t.me/channel_username`',
            '',
            '也可以直接发送：`@频道 comments` 或 `@频道 no-comments`。',
            '',
            '点击「❌ 取消」按钮即可退出（也可发送“取消”）。',
        ].join('\n');
    }

    if (state.step === 'path') {
        let scopeText: string;
        if (state.subscriptionId) {
            scopeText = '这个订阅';
        } else if (state.sources) {
            scopeText = `这 ${state.sources.length} 个频道/群组`;
        } else {
            scopeText = '本次订阅';
        }
        const sourceLabel = state.sources ? `已选 ${state.sources.length} 个频道/群组` : (state.subscriptionSource || state.source);
        return [
            title,
            `📍 ${sourceLabel}`,
            '',
            `是否要给${scopeText}单独指定保存目录？`,
            '',
            '💡 无需自定义目录时，直接点击下方「📁 使用默认目录」按钮即可继续。',
            '如需自定义，直接发送目录，例如：`频道备份/壁纸`（也可发送 `跳过` / `skip`）。',
            '',
            `说明：这里设置的目录对${scopeText}统一生效，不会改变全局 /path_rules，也不会影响其它下载。`,
            '点击「❌ 取消」或发送“取消”可退出。',
        ].join('\n');
    }

    if (state.step === 'comments') {
        return [
            title,
            `📍 频道：${state.subscriptionSource || state.source}`,
            state.customFolder ? `📁 保存目录：${state.customFolder}` : '📁 保存策略：默认自动分类',
            '',
            '是否同时扫描频道帖子下方的评论区文件？',
            '',
            `默认关闭；开启后每个频道帖子最多扫描 ${state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST} 条评论。`,
            '文字评论、普通链接和其它无文件消息会自动忽略。',
            '',
            '也可以发送：`开` / `关` / `yes` / `no`。',
            '点击「❌ 取消」按钮即可退出（也可发送“取消”）。',
        ].join('\n');
    }

    if (state.step === 'tag') {
        return [
            title,
            `📍 频道：${state.subscriptionSource || state.source}`,
            '',
            '请发送要下载的标签：',
            '例如：`#壁纸` 或 `壁纸`',
            '',
            '点击「❌ 取消」按钮即可退出（也可发送“取消”）。',
        ].join('\n');
    }

    if (state.step === 'start_date') {
        return [
            title,
            `📍 频道：${state.subscriptionSource || state.source}`,
            '',
            '请发送开始日期：',
            '格式：`YYYY-MM-DD`，例如 `2026-06-01`',
            '',
            '点击「❌ 取消」按钮即可退出（也可发送“取消”）。',
        ].join('\n');
    }

    return [
        title,
        `📍 频道：${state.source}`,
        `🗓️ 开始日期：${state.startDate}`,
        '',
        '请发送结束日期：',
        '格式：`YYYY-MM-DD`，例如 `2026-06-27`',
        '',
        '点击「❌ 取消」按钮即可退出（也可发送“取消”）。',
    ].join('\n');
}

function isDateOnly(text: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(text.trim());
}


interface TelegramDownloadScanSummary {
    source: string;
    mode: 'date' | 'tag';
    channelMessagesScanned: number;
    channelMediaFound: number;
    commentMessagesScanned: number;
    commentMediaFound: number;
    totalMediaFound: number;
    commentsEnabled: boolean;
    commentsMaxPerPost: number;
}

async function updateJobProgressMessage(statusMessage: Api.Message, summary: TelegramJobProgressSummary): Promise<void> {
    const totalDone = summary.completed + summary.failed + summary.skipped;
    const lines = [
        summary.status === 'paused' ? `⏸️ **频道下载已暂停**` : summary.status === 'cancelled' ? `🛑 **频道下载已取消**` : totalDone >= summary.totalMediaFound && summary.scanStatus === 'done' ? `✅ **频道任务完成**` : `🔎 **频道任务运行中**`,
        `🆔 job: ${summary.jobId.slice(0, 8)}`,
        `📍 频道：${summary.source}`,
        ``,
        `🔎 扫描：${summary.scanStatus}`,
        `📄 频道正文：已扫 ${summary.channelMessagesScanned} 条，发现 ${summary.channelMediaFound} 个文件`,
        `💬 评论区：已扫 ${summary.commentMessagesScanned} 条，发现 ${summary.commentMediaFound} 个文件`,
        ``,
        `⬇️ 下载：${summary.downloadStatus}`,
        `✅ 成功 ${summary.completed}　⏳ 待下载 ${summary.pending}　🔄 下载中 ${summary.downloading}　❌ 失败 ${summary.failed}　⏭ 跳过 ${summary.skipped}`,
        summary.cooldownUntil ? `⏳ FloodWait 冷却到：${summary.cooldownUntil}` : '',
        ``,
        `控制：/task_pause ${summary.jobId.slice(0, 8)} · /task_resume ${summary.jobId.slice(0, 8)} · /task_cancel ${summary.jobId.slice(0, 8)}`,
    ].filter(Boolean);
    await statusMessage.edit({ text: lines.join('\n') }).catch(() => undefined);
}

async function updateScanStatusMessage(statusMessage: Api.Message, summary: TelegramDownloadScanSummary): Promise<void> {
    const lines = [
        `🔎 **扫描完成，开始下载**`,
        `📍 频道：${summary.source}`,
        ``,
        `📄 频道正文：扫描 ${summary.channelMessagesScanned} 条，发现 ${summary.channelMediaFound} 个文件`,
        summary.commentsEnabled
            ? `💬 评论区：扫描 ${summary.commentMessagesScanned} 条，发现 ${summary.commentMediaFound} 个文件（每帖最多 ${summary.commentsMaxPerPost} 条）`
            : `💬 评论区：未启用`,
        `📦 待下载：${summary.totalMediaFound} 个文件`,
        ``,
        `⏳ 正在加入下载队列，可用 /tasks 查看后台任务。`,
    ];
    await statusMessage.edit({ text: lines.join('\n') }).catch(() => undefined);
}

async function replyWithJobResult(statusMessage: Api.Message, fallbackMessage: Api.Message, promise: Promise<any>, kind: 'date' | 'tag'): Promise<void> {
    promise
        .then(result => {
            const commentLine = result.commentMediaFound || result.commentMessagesScanned
                ? `\n评论区: 扫描 ${result.commentMessagesScanned || 0} 条，发现 ${result.commentMediaFound || 0} 个文件`
                : '';
            const text = kind === 'tag'
                ? `✅ 标签下载任务完成\n标签: ${result.tag}\nID: ${String(result.jobId).slice(0, 8)}\n入队: ${result.found}\n跳过: ${result.skipped}\n失败: ${result.failed}${commentLine}`
                : `✅ 日期范围任务完成\nID: ${String(result.jobId).slice(0, 8)}\n入队: ${result.found}\n跳过: ${result.skipped}\n失败: ${result.failed}${commentLine}`;
            statusMessage.edit({ text }).catch(() => fallbackMessage.reply({ message: text }).catch(() => undefined));
        })
        .catch(error => {
            const text = `❌ ${kind === 'tag' ? '标签' : '日期'}下载失败: ${error instanceof Error ? error.message : String(error)}`;
            statusMessage.edit({ text }).catch(() => fallbackMessage.reply({ message: text }).catch(() => undefined));
        });
}

async function startTelegramWizard(message: Api.Message, senderId: number, kind: TelegramWizardKind): Promise<void> {
    const state: TelegramWizardState = { kind, step: kind === 'tg_download' ? 'mode' : 'source' };
    telegramWizardStates.set(senderId, state);
    if (kind === 'tg_sub_manage') {
        const rows = await listTelegramSubscriptions(senderId);
        const page = resolveSubscriptionPage(senderId, rows, 0); // 每次打开面板从第一页开始
        await message.reply({ message: buildSubscriptionManagePanel(rows, page), buttons: buildSubscriptionActionKeyboard(rows, page) });
        return;
    }
    await message.reply({
        message: buildTelegramWizardPrompt(state),
        buttons: wizardStepButtons(state),
    });
}

async function handleTelegramWizardMessage(message: Api.Message, senderId: number, text: string): Promise<boolean> {
    const state = telegramWizardStates.get(senderId);
    if (!state) return false;

    const input = text.trim();
    if (!input) return true;
    if (isCancelInput(input)) {
        telegramWizardStates.delete(senderId);
        await message.reply({ message: '已取消 Telegram 频道操作向导。' });
        return true;
    }

    if (state.step === 'mode') {
        const normalizedMode = input.toLowerCase();
        if (['date', '日期', '按日期'].includes(normalizedMode)) {
            state.kind = 'tg_date';
            state.step = 'source';
        } else if (['tag', '标签', '按标签'].includes(normalizedMode)) {
            state.kind = 'tg_tag';
            state.step = 'source';
        } else {
            await message.reply({ message: '❌ 请发送 `date`/`日期` 或 `tag`/`标签`，也可以发送“取消”退出。' });
            return true;
        }
        await message.reply({ message: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        return true;
    }

    if (state.step === 'source') {
        const sourceParts = input.split(/\s+/).filter(Boolean);
        const commentFlag = sourceParts[sourceParts.length - 1]?.toLowerCase();
        if (['comments', '--comments', 'include-comments', '评论', '评论区'].includes(commentFlag)) {
            state.includeComments = true;
            state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
            sourceParts.pop();
        } else if (['no-comments', '--no-comments', 'channel-only', '仅频道'].includes(commentFlag)) {
            state.includeComments = false;
            state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
            sourceParts.pop();
        }
        state.source = sourceParts.join(' ') || input;
        if (state.kind === 'tg_sub_manage') {
            if (/^\d+$/.test(input)) {
                const rows = await listTelegramSubscriptions(senderId);
                const index = parseInt(input, 10) - 1;
                const target = rows[index];
                if (!target) {
                    await message.reply({ message: '❌ 没有这个序号，请回复列表中的序号，或发送频道用户名/链接来新增订阅。' });
                    return true;
                }
                const sub = await unsubscribeTelegramChannel(senderId, target.id);
                telegramWizardStates.delete(senderId);
                const rowsAfterCancel = await listTelegramSubscriptions(senderId);
                const cancelPage = resolveSubscriptionPage(senderId, rowsAfterCancel);
                await message.reply({
                    message: [
                        sub ? `✅ 已取消订阅 ${sub.title || sub.source}` : '❌ 未找到该订阅',
                        '',
                        buildSubscriptionManagePanel(rowsAfterCancel, cancelPage),
                    ].join('\n')
                });
                return true;
            }

            if (!input.startsWith('@') && !/^https?:\/\/t\.me\//i.test(input) && !/^-?\d+$/.test(input)) {
                await message.reply({ message: '❌ 请回复订阅序号来取消，或发送频道用户名/链接来新增订阅，例如：`@channel_username`。' });
                return true;
            }

            state.step = 'path';
            await message.reply({ message: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
            return true;
        }
        state.step = 'path';
        await message.reply({ message: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        return true;
    }

    if (state.step === 'path') {
        const skipPath = /^(跳过|skip|默认|default|无|不用|不指定)$/i.test(input);
        if (skipPath) {
            delete state.customFolder;
        } else {
            try {
                state.customFolder = await rememberRecentTelegramPathPersistent(message.chatId?.toString() || 'unknown', input);
            } catch (error) {
                await message.reply({ message: `❌ 路径无效：${(error as Error).message}\n\n请重新发送目录，或发送“跳过”使用默认保存路径规则。` });
                return true;
            }
        }

        if (state.kind === 'tg_sub_manage') {
            telegramWizardStates.delete(senderId);
            try {
                if (state.subscriptionId) {
                    const sub = await updateTelegramSubscriptionFolder(senderId, state.subscriptionId, state.customFolder || null);
                    const updated = sub ? await findSubscriptionRow(senderId, state.subscriptionId) : null;
                    const header = [
                        sub ? `✅ 已更新订阅目录：${sub.title || sub.source}` : '❌ 未找到该订阅',
                        sub && state.customFolder ? `📁 专属目录：${state.customFolder}\n${buildPathPreviewLine(state.customFolder)}` : '📁 保存策略：默认自动分类',
                    ].filter(Boolean).join('\n');
                    if (updated) {
                        const detail = buildSubscriptionDetailView(updated);
                        await message.reply({ message: `${header}\n\n${detail.text}`, buttons: detail.buttons });
                    } else {
                        const rowsAfterUpdate = await listTelegramSubscriptions(senderId);
                        const updatePage = resolveSubscriptionPage(senderId, rowsAfterUpdate);
                        await message.reply({
                            message: [header, '', buildSubscriptionManagePanel(rowsAfterUpdate, updatePage)].join('\n'),
                            buttons: buildSubscriptionActionKeyboard(rowsAfterUpdate, updatePage),
                        });
                    }
                } else if (state.sources) {
                    const subs: any[] = [];
                    const errors: string[] = [];
                    for (const src of state.sources) {
                        try {
                            const sub = await subscribeTelegramChannel(senderId, message.chatId?.toString(), src, state.customFolder);
                            if (sub) subs.push(sub);
                        } catch (e) {
                            errors.push(`${src}: ${e instanceof Error ? e.message : String(e)}`);
                        }
                    }
                    const lines: string[] = [];
                    if (subs.length > 0) {
                        lines.push(`✅ 已订阅 ${subs.length} 个频道/群组`);
                        // 仅列出前若干个，避免批量订阅时消息超出 Telegram 4096 字符上限
                        const LIST_CAP = 30;
                        for (const sub of subs.slice(0, LIST_CAP)) {
                            lines.push(`  ${sub.title || sub.source} — ${sub.source}`);
                        }
                        if (subs.length > LIST_CAP) {
                            lines.push(`  …等共 ${subs.length} 个（已全部订阅成功）`);
                        }
                    }
                    if (state.customFolder) {
                        lines.push(`📁 统一保存目录：${state.customFolder}\n${buildPathPreviewLine(state.customFolder)}`);
                    } else {
                        lines.push('📁 使用默认保存路径规则');
                    }
                    if (errors.length > 0) {
                        lines.push(`\n⚠️ ${errors.length} 个订阅失败：\n${errors.join('\n')}`);
                    }
                    await message.reply({ message: lines.join('\n') });
                } else {
                    const sub = await subscribeTelegramChannel(senderId, message.chatId?.toString(), state.source!, state.customFolder);
                    await message.reply({
                        message: [
                            `✅ 已订阅 ${sub.title || sub.source}`,
                            `📍 ${sub.source}`,
                            state.customFolder ? `📁 本订阅专属保存目录：${state.customFolder}\n${buildPathPreviewLine(state.customFolder)}` : '📁 本订阅使用默认保存路径规则',
                            `从当前最新消息 ID ${sub.last_message_id || 0} 之后开始自动同步。`,
                        ].join('\n')
                    });
                }
            } catch (error) {
                await message.reply({ message: `❌ 订阅操作失败: ${error instanceof Error ? error.message : String(error)}` });
            }
            return true;
        }

        if (state.kind === 'tg_tag' || state.kind === 'tg_date') {
            state.step = state.includeComments !== undefined ? (state.kind === 'tg_tag' ? 'tag' : 'start_date') : 'comments';
            await message.reply({ message: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
            return true;
        }
        return true;

    }

    if (state.step === 'comments') {
        const enabled = /^(开|开启|是|包含|评论|评论区|yes|y|on|true|1)$/i.test(input);
        const disabled = /^(关|关闭|否|不包含|仅频道|no|n|off|false|0)$/i.test(input);
        if (!enabled && !disabled) {
            await message.reply({ message: '❌ 请发送 `开`/`关`，或点击按钮选择是否包含评论区文件。' });
            return true;
        }
        state.includeComments = enabled;
        state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
        state.step = state.kind === 'tg_tag' ? 'tag' : 'start_date';
        await message.reply({ message: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        return true;
    }

    if (state.step === 'tag') {
        telegramWizardStates.delete(senderId);
        try {
            const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${state.source} 中带有 ${input.startsWith('#') ? input : `#${input}`} 的媒体消息...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramTagDownload(client!, message, senderId, state.source!, input, state.customFolder, {
                includeComments: Boolean(state.includeComments),
                commentsMaxPerPost: state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
                onScanComplete: summary => updateScanStatusMessage(queuedMsg as Api.Message, summary),
                onProgress: summary => updateJobProgressMessage(queuedMsg as Api.Message, summary),
            }), 'tag');
        } catch (error) {
            await message.reply({ message: `❌ 标签下载失败: ${error instanceof Error ? error.message : String(error)}` });
        }
        return true;
    }

    if (state.step === 'start_date') {
        if (!isDateOnly(input)) {
            await message.reply({ message: '❌ 日期格式必须是 YYYY-MM-DD，例如：2026-06-01' });
            return true;
        }
        state.startDate = input;
        state.step = 'end_date';
        await message.reply({ message: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        return true;
    }

    if (!isDateOnly(input)) {
        await message.reply({ message: '❌ 日期格式必须是 YYYY-MM-DD，例如：2026-06-27' });
        return true;
    }

    telegramWizardStates.delete(senderId);
    try {
        const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${state.source}：${state.startDate} → ${input}...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
        await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramDateDownload(client!, message, senderId, state.source!, state.startDate!, input, state.customFolder, {
            includeComments: Boolean(state.includeComments),
            commentsMaxPerPost: state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
            onScanComplete: summary => updateScanStatusMessage(queuedMsg as Api.Message, summary),
            onProgress: summary => updateJobProgressMessage(queuedMsg as Api.Message, summary),
        }), 'date');
    } catch (error) {
        await message.reply({ message: `❌ 日期下载失败: ${error instanceof Error ? error.message : String(error)}` });
    }
    return true;
}

// 订阅管理面板每页展示的订阅数量（保持文本与按钮一致，避免超出 Telegram 4096 字符上限）
const SUBSCRIPTION_PAGE_SIZE = 8;

// 记住每个用户当前查看的订阅管理页码，便于操作后在同一页重新渲染
const subscriptionManagePage = new Map<number, number>();

function subscriptionPageCount(rows: any[]): number {
    return Math.max(1, Math.ceil(rows.length / SUBSCRIPTION_PAGE_SIZE));
}

// 读取并夹取用户当前页码到有效范围
function resolveSubscriptionPage(userId: number, rows: any[], requested?: number): number {
    const pageCount = subscriptionPageCount(rows);
    const raw = requested ?? subscriptionManagePage.get(userId) ?? 0;
    const safe = Math.min(Math.max(0, raw), pageCount - 1);
    subscriptionManagePage.set(userId, safe);
    return safe;
}

function buildSubscriptionActionKeyboard(rows: any[], page = 0): Api.ReplyInlineMarkup {
    const pageCount = subscriptionPageCount(rows);
    const safePage = Math.min(Math.max(0, page), pageCount - 1);
    const pageRows = rows.slice(safePage * SUBSCRIPTION_PAGE_SIZE, (safePage + 1) * SUBSCRIPTION_PAGE_SIZE);
    const navButtons: Api.KeyboardButtonCallback[] = [];
    if (safePage > 0) navButtons.push(new Api.KeyboardButtonCallback({ text: '⬅️ 上一页', data: Buffer.from(`tsub_page_${safePage - 1}`) }));
    if (safePage < pageCount - 1) navButtons.push(new Api.KeyboardButtonCallback({ text: '➡️ 下一页', data: Buffer.from(`tsub_page_${safePage + 1}`) }));
    return new Api.ReplyInlineMarkup({
        rows: [
            ...pageRows.map((row, index) => {
                const globalIndex = safePage * SUBSCRIPTION_PAGE_SIZE + index;
                return new Api.KeyboardButtonRow({
                    buttons: [new Api.KeyboardButtonCallback({ text: `${globalIndex + 1}. ${row.enabled ? '' : '⏸️ '}${row.title || row.source}`, data: Buffer.from(`tsub_open_${row.id}`) })],
                });
            }),
            ...(navButtons.length > 0 ? [new Api.KeyboardButtonRow({ buttons: navButtons })] : []),
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: '➕ 从已加入的频道/群组中选择订阅', data: Buffer.from('tsub_pick_0') })],
            }),
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: '✅ 完成 / 关闭', data: Buffer.from('tsub_close') })],
            }),
        ],
    });
}

// 单个订阅的二级菜单（详情 + 操作）
function buildSubscriptionDetailView(row: any): { text: string; buttons: Api.ReplyInlineMarkup } {
    const detailRows: Api.KeyboardButtonRow[] = [
        new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '✏️ 修改专属目录', data: Buffer.from(`tsub_folder_${row.id}`) })] }),
    ];
    if (row.folder_override) {
        detailRows.push(new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '🧹 清除专属目录', data: Buffer.from(`tsub_clear_${row.id}`) })] }));
    }
    detailRows.push(new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '🗑 取消订阅', data: Buffer.from(`tsub_cancel_${row.id}`) })] }));
    detailRows.push(new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '↩️ 返回订阅列表', data: Buffer.from('tsub_back') })] }));
    return {
        text: [
            '📡 **订阅详情**',
            '',
            `${row.enabled ? '✅' : '⏸️'} ${row.title || row.source}`,
            `📍 来源：${row.source}`,
            `🆔 已同步至消息 ID：${row.last_message_id || 0}`,
            row.folder_override ? `📁 专属目录：${row.folder_override}` : '📁 保存策略：默认自动分类',
        ].join('\n'),
        buttons: new Api.ReplyInlineMarkup({ rows: detailRows }),
    };
}

async function findSubscriptionRow(userId: number, id: string): Promise<any | null> {
    const rows = await listTelegramSubscriptions(userId);
    return rows.find(r => String(r.id) === id) || null;
}

const TSUB_PICK_PAGE_SIZE = 8;

async function buildDialogPickerView(userId: number, page: number): Promise<{ text: string; buttons: Api.ReplyInlineMarkup }> {
    const { items } = await listTelegramDialogs(undefined, 200);
    const subs = await listTelegramSubscriptions(userId);
    const subscribedSources = new Set(subs.map(s => s.source));
    const subscribedTitles = new Set(subs.map(s => s.title?.toLowerCase()).filter(Boolean));
    const filtered = items.filter(item =>
        !subscribedSources.has(item.id) &&
        !subscribedTitles.has(item.title.toLowerCase())
    );
    const pageCount = Math.max(1, Math.ceil(filtered.length / TSUB_PICK_PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), pageCount - 1);
    const pageItems = filtered.slice(safePage * TSUB_PICK_PAGE_SIZE, (safePage + 1) * TSUB_PICK_PAGE_SIZE);
    const selections = getPickerSelections(userId);
    const rows = pageItems.map(item => {
        const selected = selections.has(item.id);
        return new Api.KeyboardButtonRow({
            buttons: [new Api.KeyboardButtonCallback({
                text: `${selected ? '✅ ' : '  '}${item.kind.split(' ')[0]} ${item.title}`.slice(0, 40),
                data: Buffer.from(`tsub_sel_${safePage}_${item.id}`),
            })],
        });
    });
    const navButtons: Api.KeyboardButtonCallback[] = [];
    if (safePage > 0) navButtons.push(new Api.KeyboardButtonCallback({ text: '⬅️ 上一页', data: Buffer.from(`tsub_pick_${safePage - 1}`) }));
    if (safePage < pageCount - 1) navButtons.push(new Api.KeyboardButtonCallback({ text: '➡️ 下一页', data: Buffer.from(`tsub_pick_${safePage + 1}`) }));
    navButtons.push(new Api.KeyboardButtonCallback({ text: '↩️ 返回订阅管理', data: Buffer.from('tsub_back') }));
    rows.push(new Api.KeyboardButtonRow({ buttons: navButtons }));
    if (selections.size > 0) {
        rows.push(new Api.KeyboardButtonRow({
            buttons: [new Api.KeyboardButtonCallback({
                text: `✅ 订阅所选（${selections.size} 个）`,
                data: Buffer.from('tsub_sel_done'),
            })],
        }));
    }
    return {
        text: [
            '📡 **选择要订阅的频道/群组**' + (selections.size > 0 ? `（已选 ${selections.size} 个）` : ''),
            '',
            '点击频道/群组名称可勾选/取消，选择完成后点击底部按钮订阅。',
            filtered.length > 0
                ? `（第 ${safePage + 1}/${pageCount} 页，共 ${filtered.length} 个，已隐藏 ${items.length - filtered.length} 个已订阅）`
                : '用户账号尚未加入任何可以订阅的频道/群组（所有已加入的均已订阅）。',
            '',
            '💡 私密频道/群组需要用户账号已加入后才能订阅。',
        ].join('\n'),
        buttons: new Api.ReplyInlineMarkup({ rows }),
    };
}

function buildSubscriptionManagePanel(rows: any[], page = 0): string {
    const pageCount = subscriptionPageCount(rows);
    const safePage = Math.min(Math.max(0, page), pageCount - 1);
    const shown = rows.slice(safePage * SUBSCRIPTION_PAGE_SIZE, (safePage + 1) * SUBSCRIPTION_PAGE_SIZE);
    const header = rows.length > SUBSCRIPTION_PAGE_SIZE
        ? `📡 **频道订阅管理**（第 ${safePage + 1}/${pageCount} 页，共 ${rows.length} 个）`
        : '📡 **频道订阅管理**';
    return [
        header,
        '',
        rows.length > 0
            ? shown.map((row, index) => {
                const globalIndex = safePage * SUBSCRIPTION_PAGE_SIZE + index;
                return [
                    `${globalIndex + 1}. ${row.enabled ? '✅' : '⏸️'} ${row.title || row.source}`,
                    `   ${row.source} · last_id=${row.last_message_id || 0}`,
                    row.folder_override ? `   📁 专属目录：${row.folder_override}` : '   📁 保存策略：默认自动分类',
                ].join('\n');
            }).join('\n')
            : '当前没有启用中的订阅。',
        '',
        rows.length > 0 ? '点击任一订阅可进入详情菜单，修改/清除专属目录或取消订阅。' : '点击下方 ➕ 按钮从已加入的频道/群组中选择，或回复频道用户名/链接新增订阅。',
        '回复频道用户名或链接也可新增订阅。',
        '例如：`@channel_username` 或 `https://t.me/channel_username`',
        '',
        '新增订阅时会询问是否为本订阅单独指定保存目录；该目录只影响这个订阅，不会改变全局 /path_rules。',
        '',
        '点击「✅ 完成 / 关闭」或发送“取消”可退出。',
    ].join('\n');
}

function formatSubscriptionList(rows: any[]): string {
    if (rows.length === 0) return '📭 暂无频道订阅。\n\n使用 `/tg_sub @频道` 添加订阅。';
    // Telegram 单条消息上限 4096 字符；按长度累积，超出则截断并提示剩余数量。
    const MAX_LEN = 3800;
    const header = '📡 **频道订阅**\n';
    const entries: string[] = [];
    let used = header.length;
    let shownCount = 0;
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const entry = [
            `${index + 1}. ${row.enabled ? '✅' : '⏸️'} ${row.title || row.source}`,
            `   ${row.source} · last_id=${row.last_message_id || 0}`,
            row.folder_override ? `   📁 专属目录：${row.folder_override}` : '   📁 保存策略：默认自动分类',
            `   ID: ${String(row.id).slice(0, 8)}`,
        ].join('\n');
        if (used + entry.length + 1 > MAX_LEN) break;
        entries.push(entry);
        used += entry.length + 1;
        shownCount++;
    }
    const hidden = rows.length - shownCount;
    return [
        header,
        ...entries,
        hidden > 0 ? `\n…还有 ${hidden} 个订阅未显示（共 ${rows.length} 个）。` : '',
    ].filter(Boolean).join('\n');
}

// Generate Password Keyboard
function generatePasswordKeyboard(currentLength: number): Api.ReplyInlineMarkup {
    const display = '●'.repeat(currentLength) + '-'.repeat(Math.max(0, 4 - currentLength));
    const displayWithSpaces = display.split('').join(' ');

    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `🔒  ${displayWithSpaces}`, data: Buffer.from('pwd_display') })
                ]
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '1', data: Buffer.from('pwd_1') }),
                    new Api.KeyboardButtonCallback({ text: '2', data: Buffer.from('pwd_2') }),
                    new Api.KeyboardButtonCallback({ text: '3', data: Buffer.from('pwd_3') }),
                ]
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '4', data: Buffer.from('pwd_4') }),
                    new Api.KeyboardButtonCallback({ text: '5', data: Buffer.from('pwd_5') }),
                    new Api.KeyboardButtonCallback({ text: '6', data: Buffer.from('pwd_6') }),
                ]
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '7', data: Buffer.from('pwd_7') }),
                    new Api.KeyboardButtonCallback({ text: '8', data: Buffer.from('pwd_8') }),
                    new Api.KeyboardButtonCallback({ text: '9', data: Buffer.from('pwd_9') }),
                ]
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('pwd_clear') }),
                    new Api.KeyboardButtonCallback({ text: '0', data: Buffer.from('pwd_0') }),
                    new Api.KeyboardButtonCallback({ text: '⌫', data: Buffer.from('pwd_backspace') }),
                ]
            }),
        ],
    });
}

// Handle Password Callback
async function handlePasswordCallback(update: Api.UpdateBotCallbackQuery): Promise<void> {
    if (!client) return;

    const userId = update.userId.toJSNumber();
    const data = Buffer.from(update.data || []).toString('utf-8');

    if (!data.startsWith('pwd_')) return;

    const lockSeconds = getPinLockSeconds(userId);
    if (lockSeconds > 0) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `密码错误次数过多，请 ${lockSeconds} 秒后再试`,
            alert: true,
        }));
        return;
    }

    let state = passwordInputState.get(userId);
    if (!state) {
        state = { password: '' };
        passwordInputState.set(userId, state);
    }

    try {
        if (data === 'pwd_display') {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
            return;
        }

        if (data === 'pwd_backspace') {
            state.password = state.password.slice(0, -1);
        } else if (data === 'pwd_clear') {
            state.password = '';
            passwordInputState.delete(userId);
            await client.editMessage(update.peer, {
                message: update.msgId,
                text: MSG.AUTH_CANCELLED,
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
            return;
        } else {
            const digit = data.replace('pwd_', '');
            if (/^[0-9]$/.test(digit)) {
                state.password = (state.password + digit).slice(0, TELEGRAM_PIN_REQUIRED_LENGTH);

                if (state.password.length >= TELEGRAM_PIN_REQUIRED_LENGTH) {
                    const pinOk = await verifyTelegramPin(state.password);
                    if (!pinOk) {
                        state.password = '';
                        const failure = recordPinFailure(userId);
                        const text = failure.locked
                            ? `❌ 密码错误次数过多，已临时锁定 ${failure.retryAfterSeconds} 秒。`
                            : MSG.AUTH_WRONG;
                        await client.editMessage(update.peer, {
                            message: update.msgId,
                            text,
                            buttons: generatePasswordKeyboard(0),
                        });
                        await client.invoke(new Api.messages.SetBotCallbackAnswer({
                            queryId: update.queryId,
                            message: failure.locked ? '已临时锁定' : '密码错误',
                            alert: failure.locked,
                        }));
                        return;
                    }

                    const allowedUsers = await getConfiguredTelegramAllowedUsers();
                    if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
                        state.password = '';
                        await client.editMessage(update.peer, {
                            message: update.msgId,
                            text: '⛔ 当前 Telegram 用户不在允许列表中，请在 TELEGRAM_ALLOWED_USER_IDS 或后台允许列表中加入你的 user id。',
                            buttons: generatePasswordKeyboard(0),
                        });
                        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '未在允许列表中', alert: true }));
                        return;
                    }

                    clearPinFailures(userId);
                    passwordInputState.delete(userId);

                    if (await is2FAEnabled()) {
                        userStates.set(userId, {
                            state: TelegramUserState.WAITING_2FA_LOGIN,
                            promptMessageId: update.msgId
                        });
                        await client.editMessage(update.peer, {
                            message: update.msgId,
                            text: MSG.AUTH_2FA_PROMPT,
                        });
                        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_2FA_TOAST }));
                        return;
                    }

                    await persistAuthenticatedUser(userId);
                    await client.editMessage(update.peer, {
                        message: update.msgId,
                        text: buildAuthSuccess(),
                    });
                    await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_SUCCESS }));
                    return;
                }
            }
        }

        await client.editMessage(update.peer, {
            message: update.msgId,
            text: MSG.AUTH_INPUT_PROMPT,
            buttons: generatePasswordKeyboard(state.password.length),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
    } catch (error) {
        console.error('🤖 处理密码回调失败:', error);
        try {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
        } catch (e) { /* ignore */ }
    }
}

// Handle Cleanup Button Callback
async function handleCleanupButtonCallback(update: Api.UpdateBotCallbackQuery, cleanupId: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const result = await handleCleanupCallback(cleanupId);

        // 更新原消息显示清理结果
        try {
            await client.editMessage(update.peer, {
                message: update.msgId,
                text: result.message,
            });
        } catch (e) {
            console.error('🤖 更新清理结果消息失败:', e);
        }

        // 发送回调应答
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: result.success ? '✅ 清理成功' : '❌ 清理失败'
        }));
    } catch (error) {
        console.error('🤖 处理清理回调失败:', error);
        try {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: '❌ 清理失败'
            }));
        } catch (e) { /* ignore */ }
    }
}

async function handleTaskQueueCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: MSG.AUTH_REQUIRED,
            alert: true,
        }));
        return;
    }

    const match = data.match(/^tq_(pause|resume|cancel)_(.+)$/);
    if (!match) return;
    const [, action, taskId] = match;
    const controlChatId = resolveTaskChatIdForControl(taskId);
    if (!controlChatId || !canControlTask(taskId, controlChatId, userId)) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: '任务已完成、已失效或不属于当前聊天',
            alert: true,
        }));
        return;
    }
    try {
        if (action === 'pause') {
            pauseDownloadTasks(taskId);
            await refreshSilentProgress(client, update.peer);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已暂停全局下载队列' }));
            return;
        }
        if (action === 'resume') {
            resumeDownloadTasks(taskId);
            await refreshSilentProgress(client, update.peer);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已继续全局下载队列' }));
            return;
        }
        await cancelSilentTask(client, update.peer, taskId, update.msgId, userId);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消后台任务', alert: true }));
    } catch (error) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `操作失败: ${(error as Error).message}`,
            alert: true,
        }));
    }
}

async function handleTelegramDownloadModeCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    if (data === 'tgd_cancel') {
        telegramWizardStates.delete(userId);
        await client.editMessage(update.peer, { message: update.msgId, text: '已取消频道文件下载向导。' });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
        return;
    }
    const state = telegramWizardStates.get(userId) || { kind: 'tg_download' as TelegramWizardKind, step: 'mode' as TelegramWizardStep };
    if (data === 'tgd_mode_date') {
        state.kind = 'tg_date';
        state.step = 'source';
        telegramWizardStates.set(userId, state);
        await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '按日期下载' }));
        return;
    }
    if (data === 'tgd_mode_tag') {
        state.kind = 'tg_tag';
        state.step = 'source';
        telegramWizardStates.set(userId, state);
        await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '按标签下载' }));
        return;
    }
    if (data === 'tgd_comments_on' || data === 'tgd_comments_off') {
        state.includeComments = data === 'tgd_comments_on';
        state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
        state.step = state.kind === 'tg_tag' ? 'tag' : 'start_date';
        telegramWizardStates.set(userId, state);
        await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: state.includeComments ? '将包含评论区文件' : '仅下载频道正文文件',
        }));
        return;
    }
}

async function handleTelegramSubscriptionCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    if (data === 'tsub_close') {
        clearPickerSelections(userId);
        // 若当前处于订阅管理向导（等待输入频道），一并结束，避免后续文本被误判为新增订阅
        const st = telegramWizardStates.get(userId);
        if (st?.kind === 'tg_sub_manage') telegramWizardStates.delete(userId);
        await client.editMessage(update.peer, { message: update.msgId, text: '✅ 已关闭订阅管理。随时发送 /tg_sub 或 /menu 重新打开。' });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已关闭' }));
        return;
    }
    if (data === 'tsub_back') {
        clearPickerSelections(userId);
        const rowsForPanel = await listTelegramSubscriptions(userId);
        const backPage = resolveSubscriptionPage(userId, rowsForPanel);
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildSubscriptionManagePanel(rowsForPanel, backPage),
            buttons: buildSubscriptionActionKeyboard(rowsForPanel, backPage),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
        return;
    }

    // 订阅管理翻页
    const pageMatch = data.match(/^tsub_page_(\d+)$/);
    if (pageMatch) {
        const rowsForPage = await listTelegramSubscriptions(userId);
        const targetPage = resolveSubscriptionPage(userId, rowsForPage, parseInt(pageMatch[1], 10));
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildSubscriptionManagePanel(rowsForPage, targetPage),
            buttons: buildSubscriptionActionKeyboard(rowsForPage, targetPage),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
        return;
    }

    // 勾选/取消勾选频道/群组
    const selMatch = data.match(/^tsub_sel_(\d+)_(-?\d+)$/);
    if (selMatch) {
        const page = parseInt(selMatch[1], 10);
        const dialogId = selMatch[2];
        const sel = getPickerSelections(userId);
        if (sel.has(dialogId)) sel.delete(dialogId); else sel.add(dialogId);
        const view = await buildDialogPickerView(userId, page);
        await client.editMessage(update.peer, { message: update.msgId, text: view.text, buttons: view.buttons });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
        return;
    }

    // 确认批量订阅
    if (data === 'tsub_sel_done') {
        const sel = getPickerSelections(userId);
        if (sel.size === 0) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请先选择至少一个频道或群组', alert: true }));
            return;
        }
        const sources = Array.from(sel);
        clearPickerSelections(userId);
        const state: TelegramWizardState = {
            kind: 'tg_sub_manage',
            step: 'path',
            sources,
            subscriptionSource: `已选 ${sources.length} 个频道/群组`,
        };
        telegramWizardStates.set(userId, state);
        await client.sendMessage(update.peer, { message: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已选 ${sources.length} 个，请设置保存目录` }));
        return;
    }

    const pickMatch = data.match(/^tsub_pick_(\d+)$/);
    if (pickMatch) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '正在获取频道/群组列表…' }));
        try {
            const view = await buildDialogPickerView(userId, parseInt(pickMatch[1], 10));
            await client.editMessage(update.peer, { message: update.msgId, text: view.text, buttons: view.buttons });
        } catch (error) {
            await client.sendMessage(update.peer, { message: `❌ 获取频道/群组列表失败: ${error instanceof Error ? error.message : String(error)}` });
        }
        return;
    }

    const addMatch = data.match(/^tsub_add_(-?\d+)$/);
    if (addMatch) {
        const picked = (await listTelegramDialogs(undefined, 200)).items.find(item => item.id === addMatch[1]);
        const state: TelegramWizardState = {
            kind: 'tg_sub_manage',
            step: 'path',
            source: addMatch[1],
            subscriptionSource: picked ? `${picked.title}（${addMatch[1]}）` : addMatch[1],
        };
        telegramWizardStates.set(userId, state);
        await client.sendMessage(update.peer, { message: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请设置保存目录以完成订阅' }));
        return;
    }

    // 点击某个订阅 → 进入二级详情菜单
    const openMatch = data.match(/^tsub_open_(.+)$/);
    if (openMatch) {
        const row = await findSubscriptionRow(userId, openMatch[1]);
        if (!row) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '订阅不存在或已取消', alert: true }));
            return;
        }
        const detail = buildSubscriptionDetailView(row);
        await client.editMessage(update.peer, { message: update.msgId, text: detail.text, buttons: detail.buttons });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
        return;
    }

    const match = data.match(/^tsub_(folder|clear|cancel)_(.+)$/);
    if (!match) return;
    const [, action, id] = match;
    const rows = await listTelegramSubscriptions(userId);
    const target = rows.find(row => String(row.id) === id);
    if (!target) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '订阅不存在或已取消', alert: true }));
        return;
    }

    if (action === 'folder') {
        const state: TelegramWizardState = {
            kind: 'tg_sub_manage',
            step: 'path',
            source: target.source,
            subscriptionId: target.id,
            subscriptionTitle: target.title,
            subscriptionSource: target.source,
        };
        telegramWizardStates.set(userId, state);
        await client.sendMessage(update.peer, { message: buildTelegramWizardPrompt(state), buttons: wizardStepButtons(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请发送新的专属目录' }));
        return;
    }

    if (action === 'clear') {
        await updateTelegramSubscriptionFolder(userId, id, null);
        const updated = await findSubscriptionRow(userId, id);
        if (updated) {
            const detail = buildSubscriptionDetailView(updated);
            await client.editMessage(update.peer, { message: update.msgId, text: detail.text, buttons: detail.buttons });
        } else {
            const rowsAfterClear = await listTelegramSubscriptions(userId);
            const clearPage = resolveSubscriptionPage(userId, rowsAfterClear);
            await client.editMessage(update.peer, {
                message: update.msgId,
                text: buildSubscriptionManagePanel(rowsAfterClear, clearPage),
                buttons: buildSubscriptionActionKeyboard(rowsAfterClear, clearPage),
            });
        }
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已清除专属目录' }));
        return;
    }

    if (action === 'cancel') {
        await unsubscribeTelegramChannel(userId, id);
        const rowsAfterCancel = await listTelegramSubscriptions(userId);
        const cancelPage = resolveSubscriptionPage(userId, rowsAfterCancel);
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildSubscriptionManagePanel(rowsAfterCancel, cancelPage),
            buttons: buildSubscriptionActionKeyboard(rowsAfterCancel, cancelPage),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消订阅', alert: true }));
    }
}

export async function initTelegramBot(): Promise<void> {
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

    if (!apiId || !apiHash || !botToken) {
        console.log('⚠️ 未配置 Telegram API 凭证，Bot 未启动');
        console.log('   需要设置: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_BOT_TOKEN');
        return;
    }

    try {
        console.log('🤖 Telegram Bot 正在同步存储配置...');
        await storageManager.init();
        const provider = storageManager.getProvider();
        console.log(`🤖 Telegram Bot 当前存储提供商: ${provider.name}`);
    } catch (e) {
        console.error('🤖 Telegram Bot 同步存储配置失败:', e);
    }

    try {
        const sessionDir = path.dirname(SESSION_FILE);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
        }

        let sessionString = '';
        if (fs.existsSync(SESSION_FILE)) {
            sessionString = fs.readFileSync(SESSION_FILE, 'utf-8').trim();
        }

        const session = new StringSession(sessionString);
        client = new TelegramClient(session, apiId, apiHash, {
            connectionRetries: 15,
            retryDelay: 2000,
            useWSS: false,
            deviceModel: 'TG Vault Bot',
            systemVersion: '1.0.0',
            appVersion: '1.0.0',
            floodSleepThreshold: 120,
        });

        console.log('🤖 Telegram Bot 正在启动...');

        await client.start({
            botAuthToken: botToken,
        });

        const newSession = client.session.save() as unknown as string;
        fs.writeFileSync(SESSION_FILE, newSession, { mode: 0o600 });
        try { fs.chmodSync(SESSION_FILE, 0o600); } catch (e) { console.warn('🤖 修正 Telegram Bot session 文件权限失败:', e); }

        console.log('🤖 Telegram Bot 已连接!');

        // Ensure database table exists
        try {
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_auth (
                    user_id BIGINT PRIMARY KEY,
                    authenticated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await loadAuthenticatedUsers();
        } catch (e) {
            console.error('🤖 初始化 Telegram 认证表失败:', e);
        }

        // Set Bot Commands
        try {
            await client.invoke(new Api.bots.SetBotCommands({
                scope: new Api.BotCommandScopeDefault(),
                langCode: 'zh',
                commands: [
                    new Api.BotCommand({ command: 'start', description: '开始使用 / 验证身份' }),
                    new Api.BotCommand({ command: 'menu', description: '主菜单（订阅/下载/任务/存储/设置/帮助）' }),
                    new Api.BotCommand({ command: 'tg_dialogs', description: '列出已加入的频道/群组 ID' }),
                    new Api.BotCommand({ command: 'ytdlp', description: '解析并下载链接到存储源' }),
                    new Api.BotCommand({ command: 'setup_2fa', description: '配置双重验证 (2FA)' }),
                    new Api.BotCommand({ command: 'help', description: '显示完整帮助' }),
                ]
            }));
            console.log('🤖 Bot 命令菜单已更新');
        } catch (e) {
            console.error('🤖 更新 Bot 命令菜单失败:', e);
        }

        try {
            const cleanupSetting = await query('SELECT value FROM system_settings WHERE key = $1', ['auto_cleanup_orphans']);
            if (cleanupSetting.rows[0]?.value !== undefined) {
                process.env.AUTO_CLEANUP_ORPHANS = String(cleanupSetting.rows[0].value);
            }
        } catch (e) {
            console.warn('🧹 读取自动清理设置失败，使用环境变量默认值:', e);
        }

        try {
            const fileConcurrency = await loadFileDownloadConcurrencySetting();
            console.log(`🤖 Telegram 文件级并发: ${fileConcurrency}`);
        } catch (e) {
            console.warn('🤖 读取文件级并发设置失败，使用环境变量默认值:', e);
        }

        // 启动时清理孤儿文件（默认开启，可通过 /cleanup_settings 关闭）
        if (isAutoCleanupEnabled()) {
            try {
                const stats = await cleanupOrphanFiles();
                if (stats.deletedCount > 0) {
                    console.log(`🧹 启动清理: 删除了 ${stats.deletedCount} 个孤儿文件，释放 ${stats.freedSpace}`);

                    // 向所有已认证用户发送清理通知
                    for (const userId of authenticatedUsers.keys()) {
                        try {
                            await client.sendMessage(userId, {
                                message: buildCleanupNotice(stats.deletedCount, stats.freedSpace)
                            });
                        } catch (e) {
                            // 用户可能已删除对话或阻止了 Bot
                        }
                    }
                }
            } catch (e) {
                console.error('🧹 启动清理失败:', e);
            }
        } else {
            console.log('🧹 启动孤儿清理已跳过：AUTO_CLEANUP_ORPHANS=false');
        }

        // 启动定期清理（每小时）
        startPeriodicCleanup();
        startTelegramSubscriptionWorker(client);
        startTelegramJobRecoveryWorker(client);

        // Handle Messages
        client.addEventHandler(async (event: NewMessageEvent) => {
            if (!client) return;

            try {
                const message = event.message;
                if (message.out) return; // 忽略 Bot 自己发送的消息，防止递归响应

                if (!message.text && !message.media) return;

                const senderId = message.senderId?.toJSNumber();
                if (!senderId) return;

                // 忽略过旧的消息，防止 Bot 重启时重复处理 pending updates
                const messageAge = Date.now() / 1000 - message.date;
                if (messageAge > 300) { // 超过 5 分钟的消息直接跳过
                    console.log(`🤖 跳过过旧消息 (${Math.round(messageAge)}s ago, id=${message.id})`);
                    return;
                }

                const text = message.text || '';
                const chatId = message.chatId;

                if (!chatId) return;

                const rateLimit = consumeTelegramRateLimit(senderId, text);
                if (rateLimit.limited) {
                    await message.reply({ message: `⏳ 操作过于频繁，请 ${rateLimit.retryAfterSeconds} 秒后再试。` });
                    return;
                }

                console.log(`🤖 Received text from ${senderId}: ${text}`);

                // Commands
                if (text === '/start') {
                    await handleStart(message, senderId);
                    if (!(await isAuthenticatedAsync(senderId))) {
                        // Send password keyboard if not authenticated
                        await message.reply({
                            message: buildStartPrompt(),
                            buttons: generatePasswordKeyboard(0),
                        });
                    } else {
                        // 已认证用户：展示主菜单并挂载常驻快捷键盘
                        const menu = buildMainMenu();
                        await message.reply({ message: menu.text, buttons: menu.buttons });
                        await message.reply({ message: '快捷操作已就绪 👇', buttons: buildQuickActionKeyboard() });
                    }
                    return;
                }

                // 主菜单 / 设置面板入口
                if (text === '/menu' || text === QUICK_ACTIONS.menu) {
                    if (!(await isAuthenticatedAsync(senderId))) { await message.reply({ message: MSG.AUTH_REQUIRED }); return; }
                    const menu = buildMainMenu();
                    await message.reply({ message: menu.text, buttons: menu.buttons });
                    return;
                }
                if (text === '/settings' || text === '/setting') {
                    if (!(await isAuthenticatedAsync(senderId))) { await message.reply({ message: MSG.AUTH_REQUIRED }); return; }
                    const settings = buildSettingsMenu();
                    await message.reply({ message: settings.text, buttons: settings.buttons });
                    return;
                }

                // 常驻快捷键盘按钮 → 复用现有命令流程
                if (QUICK_ACTION_VALUES.has(text)) {
                    if (!(await isAuthenticatedAsync(senderId))) { await message.reply({ message: MSG.AUTH_REQUIRED }); return; }
                    if (text === QUICK_ACTIONS.subscribe) { await startTelegramWizard(message, senderId, 'tg_sub_manage'); return; }
                    if (text === QUICK_ACTIONS.download) { await startTelegramWizard(message, senderId, 'tg_download'); return; }
                    if (text === QUICK_ACTIONS.tasks) { await handleTasks(message); return; }
                    // QUICK_ACTIONS.menu handled above
                }
                // 处理 /setup-2fa 命令
                if (text === '/setup_2fa' || text === '/setup-2fa') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    try {
                        const qrDataUrl = await generateOTPAuthUrl();
                        const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
                        const buffer = Buffer.from(base64Data, 'base64');
                        const tempPath = path.join(process.cwd(), `temp_qr_${senderId}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
                        fs.writeFileSync(tempPath, buffer);

                        const qrMessage = await client.sendFile(chatId, {
                            file: tempPath,
                            caption: build2FASetupCaption()
                        });

                        userStates.set(senderId, {
                            state: TelegramUserState.WAITING_2FA_SETUP,
                            qrMessageId: qrMessage.id
                        });

                        fs.unlinkSync(tempPath);
                    } catch (e) {
                        console.error('生成 2FA 二维码失败:', e);
                        await client.sendMessage(chatId, { message: MSG.AUTH_2FA_QR_FAIL });
                    }
                    return;
                }

                if (text === '/help') {
                    await handleHelp(message);
                    return;
                }

                // /ytdlp <url>
                {
                    const match = text.match(/^\s*\/ytdlp(?:@\w+)?(?:\s+([\s\S]*))?\s*$/i);
                    if (match) {
                        console.log(`🤖 /ytdlp command received from ${senderId}: ${text}`);
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }

                        const argsText = (match[1] || '').trim();
                    if (!argsText) {
                        await message.reply({ message: '❌ 用法: /ytdlp <url>' });
                        return;
                    }

                    const parts = argsText.split(/\s+/).filter(Boolean);
                    if (parts.length !== 1) {
                        await message.reply({ message: '❌ 只允许一个链接\n\n用法: /ytdlp <url>' });
                        return;
                    }

                    const url = parts[0];
                    try {
                        await assertPublicHttpUrl(url);
                    } catch (error) {
                        await message.reply({ message: `❌ 无效链接：${error instanceof Error ? error.message : '不允许访问该地址'}` });
                        return;
                    }

                    await handleYtDlpCommand(message, url);
                    return;
                }
                }

                if (text === '/tg_sub' || text === '/tg_subscribe') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_sub_manage');
                    return;
                }

                if (text === '/tg_download' || text === '/tg_dl') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_download');
                    return;
                }

                // 兼容旧命令，但不再展示在 Telegram 菜单中
                if (text === '/tg_date') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_date');
                    return;
                }

                if (text === '/tg_tag') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_tag');
                    return;
                }

                if (!text.startsWith('/')) {
                    if (isCancelInput(text)) {
                        const pendingMode = getPendingTelegramPathInput(chatId.toString(), senderId);
                        if (pendingMode) {
                            clearPendingTelegramPathInput(chatId.toString(), senderId);
                            await message.reply({ message: '已取消保存路径设置。' });
                            return;
                        }
                    } else {
                        try {
                            const appliedPath = await applyPendingTelegramPathInputPersistent(chatId.toString(), senderId, text);
                            if (appliedPath) {
                                await message.reply({
                                    message: appliedPath.mode === 'once'
                                        ? `📌 已设置下一次下载目录：\`${appliedPath.folder}\`\n${buildPathPreviewLine(appliedPath.folder)}\n\n此设置会在下一次成功进入下载流程时自动失效。`
                                        : `📍 已设置本会话下载目录：\`${appliedPath.folder}\`\n${buildPathPreviewLine(appliedPath.folder)}\n\n后续此聊天中的下载会优先保存到该目录，发送 /pc 可清除。`,
                                });
                                return;
                            }
                        } catch (error) {
                            await message.reply({ message: `❌ 路径无效：${(error as Error).message}\n\n请重新发送目录，或发送“取消”退出本次设置。` });
                            return;
                        }
                    }

                    const handledTelegramWizard = await handleTelegramWizardMessage(message, senderId, text);
                    if (handledTelegramWizard) return;
                }

                if (text === '/tg_dialogs' || text.startsWith('/tg_dialogs ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const keyword = text.split(/\s+/).slice(1).join(' ').trim() || undefined;
                    try {
                        const { total, items } = await listTelegramDialogs(keyword);
                        if (items.length === 0) {
                            await message.reply({ message: keyword ? `📭 没有找到标题包含「${keyword}」的频道/群组。` : '📭 用户账号尚未加入任何频道/群组。' });
                            return;
                        }
                        const lines = items.map(item => `${item.kind} ${item.title}\n   \`${item.id}\``);
                        const header = keyword ? `🔍 匹配「${keyword}」的频道/群组（${items.length}/${total}）：` : `📋 已加入的频道/群组（显示 ${items.length}/${total}，仅取最近 200 个对话）：`;
                        await message.reply({ message: [header, '', ...lines, '', '复制 ID 后可用 `/tg_sub <ID>` 订阅。'].join('\n') });
                    } catch (error) {
                        await message.reply({ message: `❌ 获取对话列表失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text === '/tg_subs' || text === '/tg_subscriptions') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const rows = await listTelegramSubscriptions(senderId);
                    await message.reply({ message: formatSubscriptionList(rows) });
                    return;
                }

                if (text.startsWith('/tg_sub ') || text.startsWith('/tg_subscribe ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const source = text.split(/\s+/).slice(1).join(' ').trim();
                    if (!source) {
                        await message.reply({ message: '❌ 用法：/tg_sub @频道' });
                        return;
                    }
                    try {
                        const sub = await subscribeTelegramChannel(senderId, chatId.toString(), source, null);
                        await message.reply({ message: `✅ 已订阅 ${sub.title || sub.source}\n📍 ${sub.source}\n从当前最新消息 ID ${sub.last_message_id || 0} 之后开始自动同步。` });
                    } catch (error) {
                        await message.reply({ message: `❌ 订阅失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text.startsWith('/tg_unsub ') || text.startsWith('/tg_unsubscribe ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const selector = text.split(/\s+/).slice(1).join(' ').trim();
                    if (!selector) {
                        await message.reply({ message: '❌ 用法：/tg_unsub @频道 或 /tg_unsub <订阅ID前缀>' });
                        return;
                    }
                    const sub = await unsubscribeTelegramChannel(senderId, selector);
                    await message.reply({ message: sub ? `✅ 已取消订阅 ${sub.title || sub.source}` : '❌ 未找到该订阅' });
                    return;
                }

                if (text.startsWith('/tg_download ') || text.startsWith('/tg_dl ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    const mode = (parts.shift() || '').toLowerCase();
                    if (mode === 'date' || mode === '日期') {
                        if (parts.length !== 3) {
                            await message.reply({ message: '❌ 用法：/tg_download date @频道 YYYY-MM-DD YYYY-MM-DD' });
                            return;
                        }
                        try {
                            const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${parts[0]}：${parts[1]} → ${parts[2]}...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramDateDownload(client, message, senderId, parts[0], parts[1], parts[2]), 'date');
                        } catch (error) {
                            await message.reply({ message: `❌ 日期下载失败: ${error instanceof Error ? error.message : String(error)}` });
                        }
                        return;
                    }
                    if (mode === 'tag' || mode === '标签') {
                        if (parts.length !== 2) {
                            await message.reply({ message: '❌ 用法：/tg_download tag @频道 #标签' });
                            return;
                        }
                        try {
                            const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${parts[0]} 中带有 ${parts[1].startsWith('#') ? parts[1] : `#${parts[1]}`} 的媒体消息...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramTagDownload(client, message, senderId, parts[0], parts[1]), 'tag');
                        } catch (error) {
                            await message.reply({ message: `❌ 标签下载失败: ${error instanceof Error ? error.message : String(error)}` });
                        }
                        return;
                    }
                    await message.reply({ message: '❌ 用法：/tg_download date @频道 YYYY-MM-DD YYYY-MM-DD\n或：/tg_download tag @频道 #标签' });
                    return;
                }

                if (text.startsWith('/tg_date ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    if (parts.length !== 3) {
                        await message.reply({ message: '❌ 用法：/tg_date @频道 YYYY-MM-DD YYYY-MM-DD' });
                        return;
                    }
                    try {
                        const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${parts[0]}：${parts[1]} → ${parts[2]}...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramDateDownload(client, message, senderId, parts[0], parts[1], parts[2]), 'date');
                    } catch (error) {
                        await message.reply({ message: `❌ 日期下载失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text.startsWith('/tg_tag ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    if (parts.length !== 2) {
                        await message.reply({ message: '❌ 用法：/tg_tag @频道 #标签' });
                        return;
                    }
                    try {
                        const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${parts[0]} 中带有 ${parts[1].startsWith('#') ? parts[1] : `#${parts[1]}`} 的媒体消息...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramTagDownload(client, message, senderId, parts[0], parts[1]), 'tag');
                    } catch (error) {
                        await message.reply({ message: `❌ 标签下载失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text === '/storage') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleStorage(message);
                    return;
                }

                if (text === '/storage_switch' || text === '/switch_storage' || text === '/storage_source') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleStorageSwitch(message);
                    return;
                }

                if (text === '/list' || text.startsWith('/list ')) {
                    await message.reply({ message: '📋 上传记录菜单已隐藏。需要查看文件时请到网页端文件列表，或使用 /storage 查看统计。' });
                    return;
                }

                if (text.startsWith('/delete ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const args = text.split(' ').slice(1);
                    await handleDelete(message, args);
                    return;
                }

                if (text === '/tasks' || text === '/task') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleTasks(message);
                    return;
                }

                if (text === '/task_pause' || text.startsWith('/task_pause ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePauseTasks(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/task_resume' || text.startsWith('/task_resume ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleResumeTasks(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/task_cancel' || text.startsWith('/task_cancel ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleCancelTask(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/tg_retry' || text.startsWith('/tg_retry ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleRetryFailedTasks(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/stop_tasks' || text === '/stop' || text === '/cancel_tasks') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleStopTasks(message);
                    return;
                }

                if (text === '/download_workers' || text === '/workers') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleDownloadWorkers(message);
                    return;
                }

                if (text === '/file_concurrency' || text === '/file_workers' || text === '/download_files') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleFileConcurrency(message);
                    return;
                }

                if (text === '/path_rules' || text === '/path' || text === '/save_rules') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePathRules(message);
                    return;
                }

                if (text === '/pc') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePathClear(message);
                    return;
                }

                if (text.startsWith('/p ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePathOnce(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text.startsWith('/ps ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePathSession(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/duplicate_mode' || text === '/duplicate' || text === '/dup') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleDuplicateMode(message);
                    return;
                }

                if (text === '/cleanup_settings' || text === '/cleanup') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleCleanupSettings(message);
                    return;
                }

                // Handle 2FA Verification (Setup or Login)
                const userState = userStates.get(senderId);
                if (userState && (userState.state === TelegramUserState.WAITING_2FA_SETUP || userState.state === TelegramUserState.WAITING_2FA_LOGIN)) {
                    // Try to extract 6 digit code from text (allow spaces or dashes)
                    const cleanText = text.replace(/[\s-]/g, '');
                    if (/^\d{6}$/.test(cleanText)) {
                        const verified = await verifyTOTP(cleanText);

                        if (verified) {
                            if (userState.state === TelegramUserState.WAITING_2FA_SETUP) {
                                if (!(await isAuthenticatedAsync(senderId))) {
                                    userStates.delete(senderId);
                                    await message.reply({ message: MSG.AUTH_REQUIRED });
                                    return;
                                }
                                await activate2FA();
                                await message.reply({ message: MSG.AUTH_2FA_ACTIVATED });
                            } else {
                                await persistAuthenticatedUser(senderId);
                                await message.reply({ message: MSG.AUTH_2FA_LOGIN_OK });
                            }

                            // Clean up sensitive messages
                            try {
                                const messagesToDelete = [message.id]; // User's code message
                                if (userState.qrMessageId) messagesToDelete.push(userState.qrMessageId);
                                if (userState.promptMessageId) messagesToDelete.push(userState.promptMessageId);

                                await client.deleteMessages(chatId, messagesToDelete, { revoke: true });
                            } catch (e) {
                                console.error('🤖 删除 2FA 相关消息失败:', e);
                            }

                            userStates.delete(senderId);
                            return;
                        } else {
                            const errorMsg = await message.reply({ message: MSG.AUTH_2FA_WRONG });

                            // Delete invalid code message and error message potentially? 
                            // Let's at least delete user message
                            try {
                                await client.deleteMessages(chatId, [message.id], { revoke: true });
                            } catch (e) { }
                            return;
                        }
                    }
                }

                // File Handling
                if (message.media) {
                    // 处理文件上传
                    await handleFileUpload(client, event);
                }
                // Unauthenticated User Text
                if (!(await isAuthenticatedAsync(senderId)) && text && !text.startsWith('/')) {
                    await message.reply({ message: MSG.UNKNOWN_TEXT });
                }
            } catch (error) {
                console.error('🤖 处理消息时发生意外错误:', error);
            }
        }, new NewMessage({ incoming: true }));

        // Handle Callbacks
        client.addEventHandler(async (update: Api.TypeUpdate) => {
            if (update.className === 'UpdateBotCallbackQuery') {
                if (!client) return;
                const activeClient = client;
                const callbackUpdate = update as Api.UpdateBotCallbackQuery;
                const data = Buffer.from(callbackUpdate.data || []).toString('utf-8');

                // 处理密码回调
                if (data.startsWith('pwd_')) {
                    await handlePasswordCallback(callbackUpdate);
                    return;
                }

                // 处理垃圾缓存清理回调
                if (data.startsWith('cleanup_')) {
                    await handleCleanupButtonCallback(callbackUpdate, data);
                    return;
                }

                // 处理并发下载 worker 设置回调
                if (data.startsWith('dw_')) {
                    await handleDownloadWorkersCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理文件级并发设置回调
                if (data.startsWith('fc_')) {
                    await handleFileConcurrencyCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理存储统计/本地文件清理/存储源切换回调
                if (data.startsWith('storage_switch_')) {
                    await handleStorageSwitchCallback(activeClient, callbackUpdate, data);
                    return;
                }

                if (data.startsWith('storage_')) {
                    await handleStorageCleanupCallback(activeClient, callbackUpdate, data);
                    return;
                }
                // 处理文件删除二次确认回调
                if (data.startsWith('del_')) {
                    await handleDeleteConfirmCallback(activeClient, callbackUpdate, data);
                    return;
                }


                // 处理保存路径规则回调
                if (data.startsWith('pr_')) {
                    await handlePathRulesCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理重复文件策略回调
                if (data.startsWith('dm_')) {
                    await handleDuplicateModeCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理频道下载模式选择回调
                if (data.startsWith('tgd_')) {
                    await handleTelegramDownloadModeCallback(callbackUpdate, data);
                    return;
                }

                // 处理频道订阅管理回调
                if (data.startsWith('tsub_')) {
                    await handleTelegramSubscriptionCallback(callbackUpdate, data);
                    return;
                }

                // 处理 /tasks 频道任务队列按钮
                if (data.startsWith('ctq_')) {
                    await handleChannelTaskQueueCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理任务队列控制回调
                if (data.startsWith('tq_')) {
                    await handleTaskQueueCallback(callbackUpdate, data);
                    return;
                }

                // 处理自动清理设置回调
                if (data.startsWith('cs_')) {
                    await handleCleanupSettingsCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 主菜单导航
                if (data.startsWith('menu_')) {
                    await handleMainMenuCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 设置面板导航
                if (data.startsWith('set_')) {
                    await handleSettingsMenuCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 向导按钮（保存目录步骤：使用默认目录 / 取消）
                if (data.startsWith('tgw_')) {
                    await handleWizardCallback(activeClient, callbackUpdate, data);
                    return;
                }
            }
        }, new Raw({}));

        console.log('🤖 Telegram Bot 启动成功! (最大 2GB，账号级下载器不受此限制)');

    } catch (error) {
        console.error('🤖 Telegram Bot 启动失败:', error);
    }
}

// 发送安全通知给所有已认证用户
export async function sendSecurityNotification(message: string): Promise<void> {
    if (!client || !client.connected) {
        console.warn('⚠️ Telegram Client 未连接，无法发送安全通知');
        return;
    }

    const authUsers = Array.from(authenticatedUsers.keys());
    for (const userId of authUsers) {
        try {
            await client.sendMessage(userId, { message });
        } catch (e) {
            console.error(`🤖 向用户 ${userId} 发送通知失败:`, e);
        }
    }
}

export default { initTelegramBot, sendSecurityNotification };
