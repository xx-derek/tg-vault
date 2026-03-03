
import { query } from './backend/src/db/index.js';

async function run() {
    try {
        const res = await query('SELECT id, name, type, mime_type, size, source, folder, created_at FROM files ORDER BY created_at DESC LIMIT 20');
        console.table(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}

run();
