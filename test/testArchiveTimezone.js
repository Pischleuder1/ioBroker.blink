'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { describe, it } = require('mocha');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
    path.join(root, 'main.js'),
    'utf8',
);

const start = source.indexOf('\tarchiveTimestamp(value) {');
const end = source.indexOf(
    '\n\tasync cleanupOrphanedArchiveFiles()',
    start,
);

assert.ok(start !== -1 && end > start);

const method = source.slice(start, end).trim();

const runner = `
    const vm = require('node:vm');

    const formatter = vm.runInNewContext(
        '(' + process.env.BLINK_TEST_METHOD + ')'
    );

    const result = formatter.archiveTimestamp(
        process.argv[1]
    );

    process.stdout.write(result);
`;

function formatInTimezone(zone, timestamp) {
    return execFileSync(
        process.execPath,
        ['-e', runner, timestamp],
        {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                TZ: zone,
                BLINK_TEST_METHOD: `{ ${method} }`,
            },
        },
    ).trim();
}

describe('Blink archive filename timezone', () => {
    it('uses Berlin winter time', () => {
        assert.equal(
            formatInTimezone(
                'Europe/Berlin',
                '2026-01-15T12:30:00.123Z',
            ),
            '2026-01-15T13-30-00-123+0100',
        );
    });

    it('uses Berlin summer time', () => {
        assert.equal(
            formatInTimezone(
                'Europe/Berlin',
                '2026-07-15T12:30:00.123Z',
            ),
            '2026-07-15T14-30-00-123+0200',
        );
    });

    it('uses New York winter and summer offsets', () => {
        assert.equal(
            formatInTimezone(
                'America/New_York',
                '2026-01-15T12:30:00.123Z',
            ),
            '2026-01-15T07-30-00-123-0500',
        );

        assert.equal(
            formatInTimezone(
                'America/New_York',
                '2026-07-15T12:30:00.123Z',
            ),
            '2026-07-15T08-30-00-123-0400',
        );
    });

    it('supports fractional-hour offsets', () => {
        assert.equal(
            formatInTimezone(
                'Asia/Kolkata',
                '2026-01-15T12:30:00.123Z',
            ),
            '2026-01-15T18-00-00-123+0530',
        );
    });

    it('supports UTC', () => {
        assert.equal(
            formatInTimezone(
                'UTC',
                '2026-01-15T12:30:00.123Z',
            ),
            '2026-01-15T12-30-00-123+0000',
        );
    });

    it('distinguishes repeated local times at DST change', () => {
        const summer = formatInTimezone(
            'Europe/Berlin',
            '2026-10-25T00:30:00.000Z',
        );

        const winter = formatInTimezone(
            'Europe/Berlin',
            '2026-10-25T01:30:00.000Z',
        );

        assert.equal(
            summer,
            '2026-10-25T02-30-00-000+0200',
        );

        assert.equal(
            winter,
            '2026-10-25T02-30-00-000+0100',
        );

        assert.notEqual(summer, winter);
    });

    it('produces filesystem-safe timestamps', () => {
        const value = formatInTimezone(
            'Europe/Berlin',
            '2026-11-28T12:30:00.123Z',
        );

        assert.match(
            value,
            /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}[+-]\d{4}$/,
        );

        assert.equal(/[\\/:*?"<>|]/.test(value), false);
    });
});

describe('Blink archive filename parser', () => {
    const data = JSON.parse(
        fs.readFileSync(
            path.join(root, 'lib/blink-video-url-server.json'),
            'utf8',
        ),
    );

    const serverSource = data.common.source;

    const parserStart = serverSource.indexOf(
        'function parseArchiveTimestamp(',
    );

    const parserEnd = serverSource.indexOf(
        '\nasync function readArchiveConfig(',
        parserStart,
    );

    assert.ok(parserStart >= 0 && parserEnd > parserStart);

    const parseArchiveTimestamp = vm.runInNewContext(
        '(' + serverSource.slice(parserStart, parserEnd).trim() + ')',
    );

    it('parses legacy UTC filenames', () => {
        assert.equal(
            parseArchiveTimestamp(
                '2026-11-28T12-30-00-000_1934050_cloud_123.mp4',
                null,
            ),
            '2026-11-28T12:30:00.000Z',
        );
    });

    it('parses local filenames with positive UTC offset', () => {
        assert.equal(
            parseArchiveTimestamp(
                '2026-11-28T13-30-00-000+0100_1934050_cloud_123.mp4',
                null,
            ),
            '2026-11-28T12:30:00.000Z',
        );
    });

    it('parses local filenames with negative UTC offset', () => {
        assert.equal(
            parseArchiveTimestamp(
                '2026-01-15T07-30-00-123-0500_1934050_cloud_123.mp4',
                null,
            ),
            '2026-01-15T12:30:00.123Z',
        );
    });

    it('parses fractional-hour offsets', () => {
        assert.equal(
            parseArchiveTimestamp(
                '2026-01-15T18-00-00-123+0530_1934050_cloud_123.mp4',
                null,
            ),
            '2026-01-15T12:30:00.123Z',
        );
    });

    it('preserves chronological order across DST change', () => {
        const filenames = [
            '2026-10-25T02-30-00-000+0100_1934050_cloud_2.mp4',
            '2026-10-25T02-30-00-000+0200_1934050_cloud_1.mp4',
        ];

        const entries = filenames.map(file => ({
            file,
            timestamp: parseArchiveTimestamp(file, null),
        }));

        entries.sort(
            (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
        );

        assert.ok(entries[0].file.endsWith('cloud_2.mp4'));
        assert.ok(entries[1].file.endsWith('cloud_1.mp4'));

        assert.equal(
            entries[0].timestamp,
            '2026-10-25T01:30:00.000Z',
        );

        assert.equal(
            entries[1].timestamp,
            '2026-10-25T00:30:00.000Z',
        );
    });

    it('uses file modification time when timestamp is missing', () => {
        const mtime = new Date('2026-11-28T10:00:00.000Z');

        assert.equal(
            parseArchiveTimestamp(
                'video_without_timestamp.mp4',
                { mtime },
            ),
            '2026-11-28T10:00:00.000Z',
        );
    });
});


describe('Blink archive grid integration', function () {
    const crypto = require('node:crypto');
    const os = require('node:os');

    const embeddedSource = JSON.parse(
        fs.readFileSync(
            path.join(root, 'lib/blink-video-url-server.json'),
            'utf8',
        ),
    ).common.source;

    function extract(startMarker, endMarker) {
        const start = embeddedSource.indexOf(startMarker);
        const end = embeddedSource.indexOf(endMarker, start);

        assert.ok(
            start >= 0 && end > start,
            'Grid function extraction failed',
        );

        return embeddedSource.slice(start, end);
    }

    function createGridHarness() {
        const directory = fs.mkdtempSync(
            path.join(os.tmpdir(), 'blink-grid-test-'),
        );

        let readCount = 0;
        const failures = new Set();

        const instrumentedFs = {
            ...fs,
            createReadStream(file, options) {
                readCount++;

                if (failures.has(path.resolve(file))) {
                    throw new Error('Simulated read failure');
                }

                return fs.createReadStream(file, options);
            },
        };

        const context = {
            fs: instrumentedFs,
            path,
            crypto,
            Map,
            Set,
            WeakMap,
            Date,

            readArchiveConfig: async () => ({
                enabled: true,
                dir: directory,
                createCameraFolders: false,
                maxClipsPerCamera: 50,
            }),

            safeArchiveSegment: value => String(value),

            archiveCandidateDirs: () => [directory],

            archiveUrl: (id, name) =>
                '/archive/' + id + '/' + name,
        };

        vm.createContext(context);

        const parserCode = extract(
            'function parseArchiveTimestamp(',
            '\nasync function readArchiveConfig(',
        );

        const hashCode = extract(
            'const archiveHashCache = new Map();',
            '\nasync function readArchiveClipsForCamera(',
        );

        const gridCode = extract(
            'async function readArchiveClipsForCamera(',
            '\n// ---------- Discover cameras automatically',
        );

        vm.runInContext(
            parserCode + '\n' +
            hashCode + '\n' +
            gridCode + '\n' +
            'this.readGrid = readArchiveClipsForCamera;' +
            'this.hashCache = archiveHashCache;',
            context,
        );

        const camera = {
            id: '12345',
            name: 'Testkamera',
        };

        function createFile(filename, contents) {
            const file = path.join(directory, filename);

            fs.writeFileSync(file, Buffer.from(contents));

            return file;
        }

        return {
            directory,
            context,
            camera,
            failures,

            createFile,

            async readGrid() {
                return context.readGrid(camera);
            },

            get readCount() {
                return readCount;
            },

            cleanup() {
                fs.rmSync(directory, {
                    recursive: true,
                    force: true,
                });
            },
        };
    }

    const prefixUtc = '2026-11-28T12-30-00-000_12345_';
    const prefixLocal = '2026-11-28T13-30-00-000+0100_12345_';

    function hashedName(hash, uuid) {
        return (
            prefixLocal +
            'cloud_sha256-' + hash +
            '_archive-' + uuid +
            '_111111.mp4'
        );
    }

    const uuidA = '550e8400-e29b-41d4-a716-446655440000';
    const uuidB = '660e8400-e29b-41d4-a716-446655440000';

    it('does not hash a single archive file', async function () {
        const h = createGridHarness();

        try {
            h.createFile(
                prefixUtc + 'cloud_111111.mp4',
                'CONTENT-A',
            );

            const clips = await h.readGrid();

            assert.equal(clips.length, 1);
            assert.equal(h.readCount, 0);
        } finally {
            h.cleanup();
        }
    });

    it('groups identical legacy contents and reuses the hash cache', async function () {
        const h = createGridHarness();

        try {
            h.createFile(
                prefixUtc + 'cloud_111111.mp4',
                'CONTENT-A',
            );

            h.createFile(
                prefixLocal + 'clip_111111.mp4',
                'CONTENT-A',
            );

            assert.equal((await h.readGrid()).length, 1);

            const initialReads = h.readCount;
            assert.equal(initialReads, 2);

            assert.equal((await h.readGrid()).length, 1);

            assert.equal(h.readCount, initialReads);
        } finally {
            h.cleanup();
        }
    });

    it('preserves different legacy contents of identical size', async function () {
        const h = createGridHarness();

        try {
            h.createFile(
                prefixUtc + 'cloud_111111.mp4',
                'CONTENT-A',
            );

            h.createFile(
                prefixLocal + 'clip_111111.mp4',
                'CONTENT-B',
            );

            assert.equal((await h.readGrid()).length, 2);
            assert.equal(h.readCount, 2);
        } finally {
            h.cleanup();
        }
    });

    it('groups identical legacy and hash-named files', async function () {
        const h = createGridHarness();

        try {
            const content = Buffer.from('SAME-CONTENT');

            const hash = crypto.createHash('sha256')
                .update(content)
                .digest('hex');

            h.createFile(
                prefixUtc + 'cloud_111111.mp4',
                content,
            );

            h.createFile(
                hashedName(hash, uuidA),
                content,
            );

            assert.equal((await h.readGrid()).length, 1);

            // Only the legacy file needs a content read.
            assert.equal(h.readCount, 1);
        } finally {
            h.cleanup();
        }
    });

    it('preserves different legacy and hash-named contents', async function () {
        const h = createGridHarness();

        try {
            const first = Buffer.from('CONTENT-A');
            const second = Buffer.from('CONTENT-B');

            const hash = crypto.createHash('sha256')
                .update(second)
                .digest('hex');

            h.createFile(
                prefixUtc + 'cloud_111111.mp4',
                first,
            );

            h.createFile(
                hashedName(hash, uuidA),
                second,
            );

            assert.equal((await h.readGrid()).length, 2);
            assert.equal(h.readCount, 1);
        } finally {
            h.cleanup();
        }
    });

    it('uses filename hashes without reading new videos', async function () {
        const h = createGridHarness();

        try {
            const first = Buffer.from('CONTENT-A');
            const second = Buffer.from('CONTENT-B');

            const hashA = crypto.createHash('sha256')
                .update(first)
                .digest('hex');

            const hashB = crypto.createHash('sha256')
                .update(second)
                .digest('hex');

            h.createFile(
                hashedName(hashA, uuidA),
                first,
            );

            h.createFile(
                hashedName(hashB, uuidB),
                second,
            );

            assert.equal((await h.readGrid()).length, 2);
            assert.equal(h.readCount, 0);
        } finally {
            h.cleanup();
        }
    });

    it('keeps videos visible when hashing fails', async function () {
        const h = createGridHarness();

        try {
            h.createFile(
                prefixUtc + 'cloud_111111.mp4',
                'CONTENT-A',
            );

            const failingFile = h.createFile(
                prefixLocal + 'clip_111111.mp4',
                'CONTENT-B',
            );

            h.failures.add(path.resolve(failingFile));

            const clips = await h.readGrid();

            assert.equal(clips.length, 2);
            assert.ok(h.readCount >= 1);
        } finally {
            h.cleanup();
        }
    });

    it('keeps repeated local times across DST separate', async function () {
        const h = createGridHarness();

        try {
            h.createFile(
                '2026-10-25T02-30-00-000+0200_' +
                    '12345_cloud_222222.mp4',
                'CONTENT-A',
            );

            h.createFile(
                '2026-10-25T02-30-00-000+0100_' +
                    '12345_cloud_222222.mp4',
                'CONTENT-B',
            );

            assert.equal((await h.readGrid()).length, 2);
            assert.equal(h.readCount, 0);
        } finally {
            h.cleanup();
        }
    });
});
