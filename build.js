const esbuild = require('esbuild');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureFreshSidecarBuild() {
    const ensureScriptPath = path.join(__dirname, 'scripts', 'ensure-sidecar-build.mjs');
    const result = spawnSync(process.execPath, [ensureScriptPath, '--mode', 'build'], {
        cwd: __dirname,
        stdio: 'inherit',
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

async function build() {
    ensureFreshSidecarBuild();

    // Ensure output directory exists
    const outDir = path.join(__dirname, 'addon', 'content', 'scripts');
    fs.mkdirSync(outDir, { recursive: true });

    console.log('Compiling TypeScript...');
    await esbuild.build({
        entryPoints: ['src/bootstrap.ts'],
        bundle: true,
        outfile: path.join(outDir, 'zotero-pdf-highlighter.js'),
        target: 'firefox115',
        format: 'iife',
        globalName: 'ZoteroPlugin',
        footer: {
            js: 'var startup = ZoteroPlugin.startup; var shutdown = ZoteroPlugin.shutdown; var install = ZoteroPlugin.install; var uninstall = ZoteroPlugin.uninstall;'
        }
    });

    console.log('Building XPI...');
    const zip = new AdmZip();

    // Add all addon/ contents
    const addonDir = path.join(__dirname, 'addon');
    addDirToZip(zip, addonDir, '');

    zip.writeZip(path.join(__dirname, 'zotero-smart-highlighter.xpi'));
    console.log('Created zotero-smart-highlighter.xpi');
}

function addDirToZip(zip, dirPath, zipPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryZipPath = zipPath ? zipPath + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
            addDirToZip(zip, fullPath, entryZipPath);
        } else {
            zip.addLocalFile(fullPath, zipPath || '');
        }
    }
}

build().catch(e => {
    console.error(e);
    process.exit(1);
});
