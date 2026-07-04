import { getSetting, setSetting } from './settings.js';

const COOKIE_SETTING_KEY = 'ytdlp_cookies';
// 单个网站 cookies 内容上限（约 256KB），防止误传大文件
export const YTDLP_COOKIE_MAX_BYTES = 256 * 1024;

type CookieStore = Record<string, string>;

// 互为别名的域名组：任一域名配置的 Cookie 对同组其它域名同样生效。
// 例如 X 同时使用 x.com 与 twitter.com，配置其一即可覆盖两种链接形式。
const DOMAIN_ALIASES: string[][] = [
    ['x.com', 'twitter.com'],
];

/**
 * 把一个主机名扩展为包含其别名域的候选主机名集合。
 * 保留子域前缀：mobile.twitter.com -> [mobile.twitter.com, mobile.x.com]。
 */
export function expandHostAliases(host: string): string[] {
    const out = new Set<string>([host]);
    for (const group of DOMAIN_ALIASES) {
        for (const base of group) {
            if (host === base || host.endsWith(`.${base}`)) {
                const prefix = host.slice(0, host.length - base.length); // '' 或 'sub.'
                for (const sibling of group) out.add(prefix + sibling);
            }
        }
    }
    return [...out];
}

/**
 * 将用户输入（域名或完整 URL）标准化为用于匹配的主机名。
 * - 去掉协议、路径、端口
 * - 转小写、去掉首尾空白
 * - 去掉开头的 "www."
 * 返回空字符串表示无法解析出有效主机名。
 */
export function normalizeCookieHost(input: string): string {
    let raw = (input || '').trim().toLowerCase();
    if (!raw) return '';
    // 如果是完整 URL，取其 hostname
    if (raw.includes('://')) {
        try {
            raw = new URL(raw).hostname;
        } catch {
            raw = raw.split('://')[1] || raw;
        }
    }
    // 去掉可能残留的路径 / 端口 / 用户信息
    raw = raw.split('/')[0].split('@').pop() || raw;
    raw = raw.split(':')[0];
    // 只保留合法主机名字符（a-z 0-9 . -），剔除零宽空格、控制符、同形异义等
    // 复制粘贴常带入的隐藏字符——否则存下的键看似 "x.com" 却与 URL 主机名不相等。
    raw = raw.toLowerCase().replace(/[^a-z0-9.-]/g, '');
    raw = raw.replace(/^\.+/, '').replace(/\.+$/, '');
    if (raw.startsWith('www.')) raw = raw.slice(4);
    return raw.trim();
}

/**
 * 从 URL 中提取标准化主机名（去掉 www.），失败返回空字符串。
 */
function hostFromUrl(url: string): string {
    try {
        let host = new URL(url).hostname.toLowerCase();
        if (host.startsWith('www.')) host = host.slice(4);
        return host;
    } catch {
        return '';
    }
}

async function getCookieStore(): Promise<CookieStore> {
    const raw = await getSetting<string>(COOKIE_SETTING_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed as CookieStore : {};
    } catch {
        return {};
    }
}

async function saveCookieStore(store: CookieStore): Promise<void> {
    await setSetting(COOKIE_SETTING_KEY, JSON.stringify(store));
}

/**
 * 列出已配置 cookies 的网站主机名（按字母序）。
 */
export async function listCookieHosts(): Promise<string[]> {
    const store = await getCookieStore();
    return Object.keys(store).sort();
}

/**
 * 列出各网站及其 cookies 字节数，供面板显示（空内容会显示为 0，便于发现异常）。
 */
export async function listCookieHostSummaries(): Promise<Array<{ host: string; bytes: number }>> {
    const store = await getCookieStore();
    return Object.keys(store).sort().map(host => ({
        host,
        bytes: Buffer.byteLength(store[host] || '', 'utf8'),
    }));
}

/**
 * 为某个主机名保存 cookies 文本（覆盖已有）。host 会被标准化，空内容会被拒绝。
 */
export async function setCookiesForHost(host: string, cookiesText: string): Promise<void> {
    const normalized = normalizeCookieHost(host);
    if (!normalized) throw new Error('无效的网站域名');
    if (!cookiesText || !cookiesText.trim()) throw new Error('Cookie 内容为空');
    const store = await getCookieStore();
    store[normalized] = cookiesText;
    await saveCookieStore(store);
}

/**
 * 删除某个主机名的 cookies。返回是否有删除。
 */
export async function deleteCookiesForHost(host: string): Promise<boolean> {
    const normalized = normalizeCookieHost(host);
    const store = await getCookieStore();
    if (!(normalized in store)) return false;
    delete store[normalized];
    await saveCookieStore(store);
    return true;
}

/**
 * 根据下载 URL 匹配最合适的已存 cookies：
 * 选取与目标主机名相等、或为其父域（后缀匹配）的、最长的已存主机名。
 * 例如目标 m.youtube.com，存有 youtube.com，则命中 youtube.com。
 */
export async function getCookiesForUrl(url: string): Promise<string | null> {
    const host = hostFromUrl(url);
    if (!host) return null;
    const store = await getCookieStore();
    const hosts = Object.keys(store);

    // 在候选主机名集合中，取相等/父域匹配里最长（最具体）的已存主机名。
    const bestMatch = (candidates: string[]): string | null => {
        let best: string | null = null;
        for (const stored of hosts) {
            for (const cand of candidates) {
                if (cand === stored || cand.endsWith(`.${stored}`)) {
                    if (!best || stored.length > best.length) best = stored;
                    break;
                }
            }
        }
        return best;
    };

    // 精确/父域匹配优先；仅当没有直接匹配时才回退到别名域（如 x.com <-> twitter.com）。
    const direct = bestMatch([host]);
    const chosen = direct ?? bestMatch(expandHostAliases(host));
    if (!chosen) return null;
    const value = store[chosen];
    // 命中主机但内容为空：视为未配置，避免写出空 cookies 文件
    return value && value.trim() ? value : null;
}

/**
 * 粗略判断文本是否像 Netscape 格式的 cookies.txt。
 * 用于在保存时给出提示，而不阻止保存。
 */
export function looksLikeCookies(text: string): boolean {
    if (!text) return false;
    if (text.includes('# Netscape HTTP Cookie File') || text.includes('# HTTP Cookie File')) return true;
    // Netscape 格式每行以制表符分隔至少 6 列
    return text.split(/\r?\n/).some(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        return trimmed.split('\t').length >= 6;
    });
}
