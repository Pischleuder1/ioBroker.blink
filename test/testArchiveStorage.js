'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

function createHarness() {
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

    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blink-archive-test-'),
    );

    const archiveDir = path.join(root, 'archive');
    fs.mkdirSync(archiveDir);

    const inputA = path.join(root, 'videoA.mp4');
    const inputB = path.join(root, 'videoB.mp4');

    fs.writeFileSync(inputA, Buffer.alloc(65536, 65));
    fs.writeFileSync(inputB, Buffer.alloc(65536, 66));

    const warnings = [];
    const states = {};

    const adapter = {
        ...methods,

        cfg: {
            archiveEnabled: true,
            archiveDir,
            archiveCreateCameraFolders: true,
        },

        camerasById: new Map([
            ['12345', { name: 'Testkamera' }],
        ]),

        safeArchiveSegment(value) {
            return String(value || '').replace(
                /[^a-zA-Z0-9_-]/g,
                '_',
            );
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

    const cameraDir = path.join(
        archiveDir,
        '12345_Testkamera',
    );

    return {
        adapter,
        root,
        cameraDir,
        inputA,
        inputB,
        warnings,
        states,

        request(file, id = '111111') {
            return {
                file,
                id,
                video_id: id,
                source: 'cloud',
                created_at: '2026-11-28T12:30:00.000Z',
            };
        },

        files() {
            if (!fs.existsSync(cameraDir)) {
                return [];
            }

            return fs.readdirSync(cameraDir)
                .filter(name => name.endsWith('.mp4'));
        },

        temporaryFiles() {
            if (!fs.existsSync(cameraDir)) {
                return [];
            }

            return fs.readdirSync(cameraDir)
                .filter(name => name.endsWith('.blink-archive.tmp'));
        },

        cleanup() {
            fs.rmSync(root, {
                recursive: true,
                force: true,
            });
        },
    };
}

describe('Blink archive storage', function () {

    it('reports true only for newly archived videos', async function () {
        const h = createHarness();

        try {
            const first = await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputA),
            );

            assert.equal(first, true);
            assert.equal(h.files().length, 1);

            const duplicate = await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputA),
            );

            assert.equal(duplicate, false);
            assert.equal(h.files().length, 1);

            h.adapter.cfg.archiveEnabled = false;

            const disabled = await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputB, '222222'),
            );

            assert.equal(disabled, false);
            assert.equal(h.files().length, 1);

            h.adapter.cfg.archiveEnabled = true;

            const missing = await h.adapter.archiveVideo(
                '12345',
                h.request(
                    path.join(h.root, 'missing.mp4'),
                    '333333',
                ),
            );

            assert.equal(missing, false);
            assert.equal(h.files().length, 1);
            assert.equal(h.warnings.length, 1);
        } finally {
            h.cleanup();
        }
    });

    it('counts only newly stored videos during backfill', async function () {
        const h = createHarness();

        try {
            const source = fs.readFileSync(
                path.join(__dirname, '..', 'main.js'),
                'utf8',
            );

            const start = source.indexOf(
                '\tasync archiveExistingVideoFilesForCamera(devId) {',
            );

            const end = source.indexOf(
                '\n\tasync archiveFileHash(file) {',
                start,
            );

            assert.ok(start >= 0 && end > start);

            const methods = vm.runInNewContext(
                '({' + source.slice(start, end) + '})',
                { fs, path },
            );

            const states = {
                'cameras.12345.video.file': h.inputA,
                'cameras.12345.video.timestamp':
                    '2026-11-28T12:30:00.000Z',
                'cameras.12345.video.id': '111111',

                'cameras.12345.video.history.0.file': h.inputA,
                'cameras.12345.video.history.0.id': '222222',

                'cameras.12345.video.history.1.file': h.inputB,
                'cameras.12345.video.history.1.id': '333333',
            };

            const results = [true, false, false];
            let calls = 0;

            const adapter = {
                ...h.adapter,
                ...methods,

                async getStateAsync(id) {
                    if (!Object.hasOwn(states, id)) {
                        return null;
                    }

                    return { val: states[id] };
                },

                fileSize(file) {
                    return fs.statSync(file).size;
                },

                async archiveVideo() {
                    return results[calls++];
                },
            };

            const count =
                await adapter.archiveExistingVideoFilesForCamera(
                    '12345',
                );

            assert.equal(calls, 3);
            assert.equal(count, 1);
            assert.equal(h.warnings.length, 0);
        } finally {
            h.cleanup();
        }
    });

    it('avoids duplicates, including legacy UTC files', async function () {
        const h = createHarness();

        try {
            await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputA),
            );

            await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputA),
            );

            assert.equal(h.files().length, 1);

            const legacy =
                '2026-11-28T12-30-00-000_' +
                '12345_clip_222222.mp4';

            fs.writeFileSync(
                path.join(h.cameraDir, legacy),
                fs.readFileSync(h.inputA),
            );

            await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputA, '222222'),
            );

            assert.equal(h.files().length, 2);
            assert.equal(h.temporaryFiles().length, 0);
            assert.equal(h.warnings.length, 0);
        } finally {
            h.cleanup();
        }
    });

    it('preserves different contents with the same video ID', async function () {
        const h = createHarness();

        try {
            await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputA),
            );

            await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputB),
            );

            assert.equal(h.files().length, 2);

            const contents = h.files().map(name =>
                fs.readFileSync(path.join(h.cameraDir, name)),
            );

            assert.ok(contents.some(data =>
                data.equals(fs.readFileSync(h.inputA)),
            ));

            assert.ok(contents.some(data =>
                data.equals(fs.readFileSync(h.inputB)),
            ));

            assert.equal(h.warnings.length, 0);
        } finally {
            h.cleanup();
        }
    });

    it('serializes ten concurrent archive calls', async function () {
        const h = createHarness();

        try {
            await Promise.all(
                Array.from({ length: 10 }, () =>
                    h.adapter.archiveVideo(
                        '12345',
                        h.request(h.inputA),
                    ),
                ),
            );

            assert.equal(h.files().length, 1);
            assert.equal(h.warnings.length, 0);
            assert.equal(h.temporaryFiles().length, 0);
            assert.equal(
                h.adapter.archiveVideoQueueByDevId.size,
                0,
            );
        } finally {
            h.cleanup();
        }
    });

    it('cleans up a failed copy and succeeds on retry', async function () {
        const h = createHarness();

        try {
            // Simulate a copy that leaves an incomplete temporary file.
            // Replace only the test method, not the global fs module.
            const originalCopy = fs.promises.copyFile;
            let failNextCopy = true;

            const isolatedFs = {
                ...fs,
                promises: {
                    ...fs.promises,
                    copyFile: async (from, to, flags) => {
                        if (failNextCopy) {
                            failNextCopy = false;

                            await fs.promises.writeFile(
                                to,
                                'INCOMPLETE',
                            );

                            throw new Error('Simulated copy failure');
                        }

                        return originalCopy(from, to, flags);
                    },
                },
            };

            // Recreate the methods with an isolated filesystem wrapper.
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

            const methods = vm.runInNewContext(
                '({' +
                    source.slice(start, end)
                        .replace(/\n\tasync /g, ',\n\tasync ') +
                    '})',
                { fs: isolatedFs, path, crypto },
            );

            Object.assign(h.adapter, methods);

            await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputA),
            );

            assert.equal(h.files().length, 0);
            assert.equal(h.temporaryFiles().length, 0);
            assert.equal(h.warnings.length, 1);
            assert.match(
                h.states['archive.lastError'],
                /Simulated copy failure/,
            );

            await h.adapter.archiveVideo(
                '12345',
                h.request(h.inputA),
            );

            assert.equal(h.files().length, 1);
            assert.equal(h.temporaryFiles().length, 0);
            assert.equal(h.states['archive.lastError'], '');
        } finally {
            h.cleanup();
        }
    });
});
