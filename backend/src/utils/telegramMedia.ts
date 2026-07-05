import { Api, TelegramClient } from 'telegram';
import { getMimeTypeFromFilename, sanitizeFilename } from './telegramUtils.js';

export interface TelegramFileInfo {
    fileName: string;
    mimeType: string;
}

export interface TelegramMessageLink {
    link: string;
    chatName: string;
}

// Cache resolved chat info to avoid repeated getEntity calls during batch jobs
interface CachedChatInfo {
    username: string | null;
    displayName: string | null;
}
const chatInfoCache = new Map<string, CachedChatInfo>();

function getChatDisplayName(chat: any): string | null {
    if (!chat) return null;
    return chat.title
        || [chat.firstName, chat.lastName].filter(Boolean).join(' ')
        || chat.username
        || null;
}

export async function buildTelegramMessageLink(
    _client: TelegramClient | undefined,
    message: Api.Message,
): Promise<TelegramMessageLink | null> {
    try {
        const chatId = message.chatId?.toString();
        if (!chatId) return null;
        const messageId = message.id;
        if (!messageId) return null;

        // Check cache first
        if (chatInfoCache.has(chatId)) {
            const cached = chatInfoCache.get(chatId)!;
            return formatMessageLink(chatId, messageId, cached);
        }

        // Resolve the chat entity to get username and display name
        const chat: any = await message.getChat().catch(() => null);
        const username: string | undefined = chat?.username;
        const displayName = getChatDisplayName(chat);

        const cached: CachedChatInfo = { username: username || null, displayName };
        chatInfoCache.set(chatId, cached);
        return formatMessageLink(chatId, messageId, cached);
    } catch {
        return null;
    }
}

function formatMessageLink(chatId: string, messageId: number, cached: CachedChatInfo): TelegramMessageLink | null {
    if (cached.username) {
        return {
            link: `https://t.me/${cached.username}/${messageId}`,
            chatName: cached.displayName || cached.username,
        };
    }
    // Private channels/supergroups have IDs like -1001234567890
    if (chatId.startsWith('-100')) {
        const numericId = chatId.slice(4);
        return {
            link: `https://t.me/c/${numericId}/${messageId}`,
            chatName: cached.displayName || numericId,
        };
    }
    // Regular private chats - no link available
    return null;
}

export function getDownloadableMedia(message: Api.Message): any | null {
    if (!message.media) return null;
    const media: any = message.media;
    if (message.sticker) return null;
    // 链接预览（MessageMediaWebPage）：只有内嵌了文档/图片才可下载，且必须返回内嵌对象，
    // 否则会把整个 webpage 包装传给 iterDownload，触发 "Cannot cast MessageMediaWebPage"。
    // 必须先于下面的便捷 getter 判断，因为 message.video/photo 等 getter 会穿透进 webpage。
    if (media.className === 'MessageMediaWebPage') {
        return media.webpage?.document || media.webpage?.photo || null;
    }
    if (message.document || message.photo || message.video || message.audio || message.voice) {
        return message.media;
    }
    if (media.document || media.photo) {
        return media.document || media.photo;
    }
    if (media.webpage?.document || media.webpage?.photo) {
        return media.webpage.document || media.webpage.photo;
    }
    return null;
}

export function isTelegramPhotoMedia(media: any): boolean {
    const inner = media?.photo || media;
    return media?.className === 'MessageMediaPhoto' || inner?.className === 'Photo' || Boolean(inner?.sizes);
}

export function getEstimatedFileSize(message: Api.Message): number {
    const media = getDownloadableMedia(message);
    if (isTelegramPhotoMedia(media)) {
        return 0;
    }
    const document = (media as any)?.document || media;
    if (document?.size) {
        return Number(document.size) || 0;
    }
    return 0;
}

function getDocumentFilename(document: any, fallback: string): string {
    const fileNameAttr = document.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
    return fileNameAttr?.fileName || fallback;
}

export function extractFileInfo(message: Api.Message): TelegramFileInfo | null {
    const downloadableMedia = getDownloadableMedia(message);
    if (!downloadableMedia) return null;

    let fileName = 'unknown';
    let mimeType = 'application/octet-stream';

    try {
        if (message.document) {
            const doc = message.document as Api.Document;
            const fileNameAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || `file_${message.id}`;
            mimeType = doc.mimeType || getMimeTypeFromFilename(fileName);

            if (fileName.startsWith('file_')) {
                const videoAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeVideo');
                const audioAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeAudio');
                if (videoAttr) fileName = `video_${message.id}.mp4`;
                else if (audioAttr) fileName = `audio_${message.id}.mp3`;
            }
        } else if (message.photo) {
            const date = new Date((message.date || Math.floor(Date.now() / 1000)) * 1000);
            const timestamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
            fileName = `Img_${timestamp}_${message.id}.jpg`;
            mimeType = 'image/jpeg';
        } else if (message.video) {
            const video = message.video as Api.Document;
            const fileNameAttr = video.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || `video_${message.id}.mp4`;
            mimeType = video.mimeType || 'video/mp4';
        } else if (message.audio) {
            const audio = message.audio as Api.Document;
            const fileNameAttr = audio.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || `audio_${message.id}.mp3`;
            mimeType = audio.mimeType || 'audio/mpeg';
        } else if (message.voice) {
            fileName = `voice_${message.id}.ogg`;
            mimeType = 'audio/ogg';
        } else {
            const media = message.media as any;
            if (media.document && media.document instanceof Api.Document) {
                const doc = media.document;
                const fileNameAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
                fileName = fileNameAttr?.fileName || `file_${message.id}`;
                mimeType = doc.mimeType || getMimeTypeFromFilename(fileName);
            } else {
                const document = (downloadableMedia as any).document || (downloadableMedia as any);
                const photo = (downloadableMedia as any).photo || (downloadableMedia as any);
                if (document?.className === 'Document' || document?.attributes) {
                    fileName = getDocumentFilename(document, `file_${message.id}`);
                    mimeType = document.mimeType || getMimeTypeFromFilename(fileName);
                } else if (photo?.className === 'Photo' || photo?.sizes) {
                    const date = new Date((message.date || Math.floor(Date.now() / 1000)) * 1000);
                    const timestamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
                    fileName = `Img_${timestamp}_${message.id}.jpg`;
                    mimeType = 'image/jpeg';
                } else {
                    return null;
                }
            }
        }
    } catch (e) {
        console.error('🤖 提取文件信息出错:', e);
        return null;
    }

    return { fileName: sanitizeFilename(fileName), mimeType };
}
