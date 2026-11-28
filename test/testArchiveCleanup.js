'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function createHarness(cameraFolders = true) {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'main.js'),
        'utf8',
    );

    const start = source.indexOf(
        '\tasync cleanupOrphanedArchiveFiles() {',
    );

    const end = source.indexOf(
        '\n\tasync archiveExistingVideoFiles() {',
        start,
    );

    assert.ok(start >= 0 && end > start);

    const method = source.slice(start, end).trim();

    const methods = vm.runInNewContext(
        '({' + method + '})',
        { fs, path, Date },
    );

    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blink-cleanup-test-'),
    );

    const cameraDir = path.join(root, '12345_Testkamera');
    const foreignDir = path.join(root, '99999_Fremd');

    fs.mkdirSync(cameraDir);
    fs.mkdirSync(foreignDir);

    const logs = [];

    const adapter = {
        ...methods,

        cfg: {
            archiveEnabled: true,
            archiveDir: root,
            archiveCreateCameraFolders: cameraFolders,
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

        log: {
            debug(message) {
                logs.push(message);
            },
            warn(message) {
                logs.push(message);
            },
            info(message) {
                logs.push(message);
            },
        },
    };

    return {
        root,
        cameraDir,
        foreignDir,
        adapter,
        logs,

        createFile(dir, name, hoursOld) {
            const file = path.join(dir, name);

            fs.writeFileSync(file, 'TESTDATA');

            const time = new Date(
                Date.now() - hoursOld * 3600000,
            );

            fs.utimesSync(file, time, time);

            return file;
        },

        cleanup() {
            fs.rmSync(root, {
                recursive: true,
                force: true,
            });
        },
    };
}

const uuid1 = '.550e8400-e29b-41d4-a716-446655440000.blink-archive.tmp';
const uuid2 = '.660e8400-e29b-41d4-a716-446655440000.blink-archive.tmp';
const uuid3 = '.770e8400-e29b-41d4-a716-446655440000.blink-archive.tmp';

describe('Blink archive orphan cleanup', function () {
    it('removes old temporary files from known camera folders', async function () {
        const h = createHarness();

        try {
            const oldFile = h.createFile(
                h.cameraDir,
                uuid1,
                72,
            );

            const removed =
                await h.adapter.cleanupOrphanedArchiveFiles();

            assert.equal(removed, 1);
            assert.equal(fs.existsSync(oldFile), false);
        } finally {
            h.cleanup();
        }
    });

    it('preserves recent temporary files', async function () {
        const h = createHarness();

        try {
            const recentFile = h.createFile(
                h.cameraDir,
                uuid1,
                1,
            );

            const removed =
                await h.adapter.cleanupOrphanedArchiveFiles();

            assert.equal(removed, 0);
            assert.equal(fs.existsSync(recentFile), true);
        } finally {
            h.cleanup();
        }
    });

    it('preserves completed videos and unrelated files', async function () {
        const h = createHarness();

        try {
            const video = h.createFile(
                h.cameraDir,
                '2026-11-28T13-30-00-000+0100_12345_cloud_111111.mp4',
                96,
            );

            const unrelated = h.createFile(
                h.cameraDir,
                'unrelated.tmp',
                96,
            );

            const removed =
                await h.adapter.cleanupOrphanedArchiveFiles();

            assert.equal(removed, 0);
            assert.equal(fs.existsSync(video), true);
            assert.equal(fs.existsSync(unrelated), true);
        } finally {
            h.cleanup();
        }
    });

    it('does not enter unrelated camera directories', async function () {
        const h = createHarness();

        try {
            const known = h.createFile(
                h.cameraDir,
                uuid1,
                72,
            );

            const foreign = h.createFile(
                h.foreignDir,
                uuid2,
                72,
            );

            const removed =
                await h.adapter.cleanupOrphanedArchiveFiles();

            assert.equal(removed, 1);
            assert.equal(fs.existsSync(known), false);
            assert.equal(fs.existsSync(foreign), true);
        } finally {
            h.cleanup();
        }
    });

    it('supports archives without per-camera directories', async function () {
        const h = createHarness(false);

        try {
            const rootFile = h.createFile(
                h.root,
                uuid3,
                72,
            );

            const removed =
                await h.adapter.cleanupOrphanedArchiveFiles();

            assert.equal(removed, 1);
            assert.equal(fs.existsSync(rootFile), false);
        } finally {
            h.cleanup();
        }
    });

    it('does nothing when archive storage is disabled', async function () {
        const h = createHarness();

        try {
            const oldFile = h.createFile(
                h.cameraDir,
                uuid1,
                72,
            );

            h.adapter.cfg.archiveEnabled = false;

            const removed =
                await h.adapter.cleanupOrphanedArchiveFiles();

            assert.equal(removed, 0);
            assert.equal(fs.existsSync(oldFile), true);
        } finally {
            h.cleanup();
        }
    });
});
