'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

function createHarness() {
    const source = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, '..', 'lib/blink-video-url-server.json'),
            'utf8',
        ),
    ).common.source;

    const start = source.indexOf(
        'const archiveHashCache = new Map();',
    );

    const end = source.indexOf(
        '\nasync function readArchiveClipsForCamera(',
        start,
    );

    assert.ok(start >= 0 && end > start);

    const context = { fs, path, crypto };

    vm.createContext(context);

    vm.runInContext(
        source.slice(start, end) +
            '\nthis.hashFile = archiveContentHash;' +
            '\nthis.cache = archiveHashCache;' +
            '\nthis.cacheLimit = ARCHIVE_HASH_CACHE_LIMIT;',
        context,
    );

    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blink-hash-test-'),
    );

    return {
        ...context,
        root,
        createFile(name, data) {
            const file = path.join(root, name);
            fs.writeFileSync(file, data);
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

describe('Blink archive SHA-256 cache', function () {
    it('calculates the correct SHA-256 hash', async function () {
        const h = createHarness();

        try {
            const data = Buffer.alloc(32768, 65);
            const file = h.createFile('video.mp4', data);

            const expected = crypto
                .createHash('sha256')
                .update(data)
                .digest('hex');

            const actual = await h.hashFile(
                file,
                fs.statSync(file),
            );

            assert.equal(actual, expected);
            assert.equal(h.cache.size, 1);
        } finally {
            h.cleanup();
        }
    });

    it('reuses cached results and concurrent requests', async function () {
        const h = createHarness();

        try {
            const file = h.createFile(
                'video.mp4',
                Buffer.alloc(8192, 66),
            );

            const stat = fs.statSync(file);

            const results = await Promise.all([
                h.hashFile(file, stat),
                h.hashFile(file, stat),
                h.hashFile(file, stat),
            ]);

            assert.equal(results[0], results[1]);
            assert.equal(results[1], results[2]);
            assert.equal(h.cache.size, 1);
        } finally {
            h.cleanup();
        }
    });

    it('invalidates cached hashes when file metadata changes', async function () {
        const h = createHarness();

        try {
            const file = h.createFile(
                'video.mp4',
                Buffer.alloc(8192, 65),
            );

            const first = await h.hashFile(
                file,
                fs.statSync(file),
            );

            fs.writeFileSync(
                file,
                Buffer.alloc(8192, 66),
            );

            const newerTime = new Date(Date.now() + 5000);
            fs.utimesSync(file, newerTime, newerTime);

            const second = await h.hashFile(
                file,
                fs.statSync(file),
            );

            assert.notEqual(first, second);
            assert.equal(h.cache.size, 2);
        } finally {
            h.cleanup();
        }
    });

    it('removes failed entries from the cache', async function () {
        const h = createHarness();

        try {
            const missing = path.join(
                h.root,
                'missing.mp4',
            );

            await assert.rejects(
                h.hashFile(missing, {
                    size: 123,
                    mtimeMs: 1,
                    ctimeMs: 1,
                }),
            );

            assert.equal(h.cache.size, 0);
        } finally {
            h.cleanup();
        }
    });

    it('limits the cache to 512 entries', async function () {
        const h = createHarness();

        try {
            const file = h.createFile(
                'video.mp4',
                Buffer.from('CACHE-LIMIT-TEST'),
            );

            const stat = fs.statSync(file);

            assert.equal(h.cacheLimit, 512);

            // Different metadata creates independent cache keys.
            // Every request reads only the tiny local test file.
            for (let i = 0; i < 520; i++) {
                await h.hashFile(file, {
                    size: stat.size,
                    mtimeMs: stat.mtimeMs + i,
                    ctimeMs: stat.ctimeMs,
                });
            }

            assert.equal(h.cache.size, 512);
        } finally {
            h.cleanup();
        }
    });
});
