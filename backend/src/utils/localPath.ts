import fs from 'fs';
import path from 'path';

export function isPathInside(baseDir: string, targetPath: string): boolean {
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

export function safeJoin(baseDir: string, ...segments: string[]): string {
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(resolvedBase, ...segments);
    if (!isPathInside(resolvedBase, resolvedTarget)) {
        throw new Error('Unsafe path outside storage directory');
    }
    return resolvedTarget;
}

export function getRelativeStoragePath(baseDir: string, targetPath: string): string | null {
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(targetPath);
    if (!isPathInside(resolvedBase, resolvedTarget)) return null;
    return path.relative(resolvedBase, resolvedTarget).split(path.sep).join('/');
}

export async function safeUnlink(filePath: string | null | undefined, baseDir: string): Promise<boolean> {
    if (!filePath) return false;
    if (!isPathInside(baseDir, filePath)) {
        console.warn(`Refusing to delete path outside storage directory: ${filePath}`);
        return false;
    }
    if (!fs.existsSync(filePath)) return false;
    await fs.promises.unlink(filePath);
    return true;
}
