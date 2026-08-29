import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

// Google/Bing menerima maksimal 50.000 URL atau 50 MB per sitemap.
// Batas 10.000 dipilih agar response tetap ringan untuk server kecil.
export const SITEMAP_PAGE_SIZE = 10_000;

const isoDate = (value) => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : undefined;
};

const publicRecord = (row) => {
    if (!row || row.public === false || row.is_public === false || row.indexable === false
        || row.visibility === 'private' || row.visibility === 'members' || row.requires_login === true) return null;
    const path = String(row.path || row.url || '').trim();
    if (!path || !path.startsWith('/') || path.startsWith('//') || /^(?:\/api|\/admin|\/account|\/login|\/register|\/set-lang)/i.test(path)) return null;
    return { path: path.split(/[?#]/)[0], lastmod: isoDate(row.lastmod || row.updated_at || row.updatedAt || row.created_at) };
};

// Adapter database opsional. Modul tersebut wajib mengekspor:
// export async function getSitemapRecords() { return [{ path, lastmod, public: true }] }
async function loadDatabaseRecords() {
    if (!process.env.SITEMAP_DB_MODULE) return [];
    const configuredModule = process.env.SITEMAP_DB_MODULE;
    const modulePath = configuredModule.startsWith('.') ? pathToFileURL(resolve(process.cwd(), configuredModule)).href : configuredModule;
    const module = await import(modulePath);
    const rows = await module.getSitemapRecords();
    return Array.isArray(rows) ? rows.map(publicRecord).filter(Boolean) : [];
}

// Berguna untuk deploy tanpa DB: file JSON array atau JSONL yang dihasilkan job import.
async function loadFileRecords() {
    if (!process.env.SITEMAP_DATA_FILE) return [];
    const text = await readFile(process.env.SITEMAP_DATA_FILE, 'utf8');
    const rows = text.trim().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    return rows.map(publicRecord).filter(Boolean);
}

export async function getSitemapRecords(staticRecords = []) {
    const rows = [...staticRecords.map(publicRecord).filter(Boolean)];
    rows.push(...await loadDatabaseRecords(), ...await loadFileRecords());
    return [...new Map(rows.map((row) => [row.path, row])).values()];
}

export function renderUrlset(records, { absoluteUrl, xmlEscape }) {
    const body = records.map(({ path, lastmod, changefreq = 'weekly', priority = '0.5' }) => [
        '  <url>', `    <loc>${xmlEscape(absoluteUrl(path))}</loc>`,
        lastmod ? `    <lastmod>${xmlEscape(lastmod)}</lastmod>` : '',
        `    <changefreq>${changefreq}</changefreq>`, `    <priority>${priority}</priority>`, '  </url>',
    ].filter(Boolean).join('\n')).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function renderIndex(files, { absoluteUrl, xmlEscape }) {
    const body = files.map(({ path, lastmod }) => `  <sitemap>\n    <loc>${xmlEscape(absoluteUrl(path))}</loc>${lastmod ? `\n    <lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}\n  </sitemap>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}
