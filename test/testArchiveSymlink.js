'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

function createHarness() {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blink-symlink-test-'),
    );

    const sourceFile = path.join(root, 'source.mp4');

    fs.writeFileSync(
        sourceFile,
        Buffer.from('SYMLINK-SECURITY-VIDEO'),
    );

    const source = fs.readFileSync(
        path.join(__dirname, '..', 'main.js'),
        'utf8',
    );

    const start = source.indexOf(
        '\tasync archiveFileHash(file) {',
    );

    const end = source.indexOf(
        '\n\tasync publishMotionSnapshotFromVideo(',
        start,
    );

    assert.ok(start >= 0 && end > start);

    const methods = vm.runInNewContext(
        '({' +
            source.slice(start, end)
                .replace(/\n\tasync /g, ',\n\tasync ') +
            '})',
        { fs, path, crypto },
    );

    const warnings = [];
    const states = {};

    const adapter = {
        ...methods,

        cfg: {
            archiveEnabled: true,
            archiveDir: '',
            archiveCreateCameraFolders: true,
        },

        camerasById: new Map([
            ['12345', { name: 'Testkamera' }],
        ]),

        safeArchiveSegment(value) {
            return String(value || '')
                .replace(/[^a-zA-Z0-9_-]/g, '_');
        },

        archiveTimestamp() {
            return '2026-11-28T13-30-00-000+0100';
        },

        isUsableFile(file) {
            try {
                const stat = fs.statSync(file);
                return stat.isFile() && stat.size > 0;
            } catch {
                return false;
            }
        },

        async updateArchiveAvailabilityState() {
            return true;
        },

        async setStateAsync(key, value) {
            states[key] = value;
        },

        log: {
            debug() {},
            warn(message) {
                warnings.push(message);
            },
        },
    };

    return {
        root,
        sourceFile,
        adapter,
        warnings,
        states,

        async archive() {
            await adapter.archiveVideo('12345', {
                file: sourceFile,
                id: '111111',
                source: 'cloud',
                created_at: '2026-11-28T12:30:00.000Z',
            });
        },

        cleanup() {
            fs.rmSync(root, {
                recursive: true,
                force: true,
            });
        },
    };
}

describe('Blink archive symlink security', function () {
    it('rejects a camera directory pointing outside the archive', async function () {
        const h = createHarness();

        try {
            const archiveDir = path.join(h.root, 'archive');
            const externalDir = path.join(h.root, 'external');

            fs.mkdirSync(archiveDir);
            fs.mkdirSync(externalDir);

            fs.symlinkSync(
                externalDir,
                path.join(archiveDir, '12345_Testkamera'),
                'dir',
            );

            h.adapter.cfg.archiveDir = archiveDir;

            await h.archive();

            assert.deepEqual(
                fs.readdirSync(externalDir),
                [],
            );

            assert.equal(h.warnings.length, 1);

            assert.match(
                h.warnings[0],
                /escaped archive directory via symbolic link/,
            );

            assert.match(
                h.states['archive.lastError'],
                /escaped archive directory via symbolic link/,
            );
        } finally {
            h.cleanup();
        }
    });

    it('allows the configured archive root itself to be a symlink', async function () {
        const h = createHarness();

        try {
            const actualArchive = path.join(
                h.root,
                'actual-archive',
            );

            const archiveLink = path.join(
                h.root,
                'archive-link',
            );

            fs.mkdirSync(actualArchive);

            fs.symlinkSync(
                actualArchive,
                archiveLink,
                'dir',
            );

            h.adapter.cfg.archiveDir = archiveLink;

            await h.archive();

            const cameraDir = path.join(
                actualArchive,
                '12345_Testkamera',
            );

            assert.ok(fs.existsSync(cameraDir));

            const files = fs.readdirSync(cameraDir)
                .filter(name => name.endsWith('.mp4'));

            assert.equal(files.length, 1);

            assert.deepEqual(
                fs.readFileSync(
                    path.join(cameraDir, files[0]),
                ),
                fs.readFileSync(h.sourceFile),
            );

            assert.equal(h.warnings.length, 0);
            assert.equal(h.states['archive.lastError'], '');
        } finally {
            h.cleanup();
        }
    });
});
