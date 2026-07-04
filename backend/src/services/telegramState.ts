import { query } from '../db/index.js';
import { getConfiguredTelegramAllowedUsers } from '../utils/authSettings.js';

// Telegram User States
export enum TelegramUserState {
    IDLE = 'IDLE',
    WAITING_2FA_LOGIN = 'WAITING_2FA_LOGIN',
    WAITING_2FA_SETUP = 'WAITING_2FA_SETUP',
}

// User state storage
export const userStates = new Map<number, {
    state: TelegramUserState;
    qrMessageId?: number;
    promptMessageId?: number;
}>();

// Authenticated user storage (Cache)
export const authenticatedUsers = new Map<number, { authenticatedAt: Date }>();

// Password input state
export const passwordInputState = new Map<number, { password: string }>();

// yt-dlp 登录 cookies 配置流程状态（跨 telegramBot 文本处理与 telegramUpload 文件处理共享）
// step 'host' 等待用户发送域名；step 'value' 等待用户上传 cookies.txt 或粘贴其内容。
export const cookieEntryState = new Map<number, { step: 'host' | 'value'; host?: string }>();

export async function revokeAuthenticatedUser(userId: number): Promise<void> {
    authenticatedUsers.delete(userId);
    try {
        await query('DELETE FROM telegram_auth WHERE user_id = $1', [userId]);
    } catch (error) {
        console.error('🤖 撤销 Telegram 授权用户失败:', error);
    }
}

// Initialize authenticated users from database
export async function loadAuthenticatedUsers(): Promise<void> {
    try {
        const allowedUsers = await getConfiguredTelegramAllowedUsers();
        const result = await query('SELECT user_id, authenticated_at FROM telegram_auth');
        for (const row of result.rows) {
            const userId = Number(row.user_id);
            if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
                await revokeAuthenticatedUser(userId);
                continue;
            }
            authenticatedUsers.set(userId, { authenticatedAt: new Date(row.authenticated_at) });
        }
        console.log(`🤖 已从数据库载入 ${authenticatedUsers.size} 个授权用户`);
    } catch (error) {
        console.error('🤖 载入已验证用户失败:', error);
    }
}

// Persist authenticated user to database
export async function persistAuthenticatedUser(userId: number): Promise<void> {
    try {
        await query('INSERT INTO telegram_auth (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
        authenticatedUsers.set(userId, { authenticatedAt: new Date() });
        console.log(`🤖 用户 ${userId} 已持久化到数据库`);
    } catch (error) {
        console.error('🤖 持久化用户失败:', error);
    }
}

// Fast cache-only check for legacy callers. Prefer isAuthenticatedAsync for command/callback authorization.
export function isAuthenticated(userId: number): boolean {
    return authenticatedUsers.has(userId);
}

// Check if user is authenticated and still allowed by env/DB allowlist.
export async function isAuthenticatedAsync(userId: number): Promise<boolean> {
    const allowedUsers = await getConfiguredTelegramAllowedUsers();
    if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
        if (authenticatedUsers.has(userId)) await revokeAuthenticatedUser(userId);
        return false;
    }
    return authenticatedUsers.has(userId);
}
