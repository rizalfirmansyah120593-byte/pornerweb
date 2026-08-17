import { createReadStream } from 'fs';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const zipFile = join(root, 'pornhub.com-db.zip');
const tempDir = join(root, '.pornhub-csv-extract');
const outputFile = join(root, 'config', 'pornstar-thumbnails.json');
const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim();

async function findCsv(directory, result = []) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await findCsv(file, result);
        else if (entry.name.toLowerCase().endsWith('.csv')) result.push(file);
    }
    return result;
}

await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });
console.log('Mengekstrak ZIP...');
await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`], { windowsHide: true, maxBuffer: 1024 * 1024 });
const csvFiles = await findCsv(tempDir);
if (!csvFiles.length) throw new Error('Tidak menemukan file CSV di dalam ZIP.');

const index = {};
let rows = 0;
console.log(`Membaca ${csvFiles[0]}...`);
const input = createInterface({ input: createReadStream(csvFiles[0], { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of input) {
    const fields = line.split('|');
    const thumbnail = String(fields[1] || '').trim();
    if (!thumbnail) continue;
    for (const model of String(fields[6] || '').split(';')) {
        const key = normalize(model);
        if (key && !index[key]) index[key] = thumbnail;
    }
    rows += 1;
    if (rows % 100000 === 0) console.log(`Dibaca ${rows.toLocaleString()} baris, ${Object.keys(index).length.toLocaleString()} model...`);
}
await writeFile(outputFile, JSON.stringify(index), 'utf8');
await rm(tempDir, { recursive: true, force: true });
console.log(`Selesai: ${Object.keys(index).length.toLocaleString()} model disimpan ke ${outputFile}`);
