'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, '..', 'lib/blink-video-url-server.json'),
        'utf8',
    ),
).common.source;

const start = source.indexOf(
    'if (urlPath.startsWith(ARCHIVE_BASE)) {',
);

const next = source.indexOf(
    'if (urlPath.startsWith(VIDEO_BASE)) {',
    start,
);

assert.ok(start >= 0 && next > start);

const handlerSource = source.slice(start, next);

function createHarness(cameraFolders = false, linkedRoot = false) {
    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blink-download-test-'),
    );

    const actualRoot = path.join(temporaryRoot, 'actual-archive');
    const archiveRoot = linkedRoot
        ? path.join(temporaryRoot, 'archive-link')
        : actualRoot;

    const external = path.join(temporaryRoot, 'external');

    fs.mkdirSync(actualRoot);
    fs.mkdirSync(external);

    if (linkedRoot) {
        fs.symlinkSync(actualRoot, archiveRoot, 'dir');
    }

    const context = {
        fs,
        path,
        ARCHIVE_BASE: '/archive/',
        VIDEO_BASE: '/blink/',
        CAMERA_PREFIX: 'blink.0.cameras.',
        NAME_STATE: '.info.name',
        MIME: { '.mp4': 'video/mp4' },

        readArchiveConfig: async () => ({
            enabled: true,
            dir: archiveRoot,
            createCameraFolders: cameraFolders,
        }),

        readStateString: async () => 'Testkamera',

        archiveCandidateDirs: root => [
            path.join(root, '12345_Testkamera'),
        ],

        log() {},
    };

    vm.createContext(context);

    vm.runInContext(
        'this.handleArchive = async function(urlPath, req, res) {' +
            handlerSource +
            '\n};',
        context,
    );

    return {
        actualRoot,
        archiveRoot,
        external,

        async request(filename) {
            const response = {
                status: null,
                streamed: null,

                writeHead(status) {
                    this.status = status;
                },

                end() {},
            };

            context.serveFile = (req, res, file) => {
                res.streamed = file;
                res.status = 200;
            };

            const url = '/archive/12345/' +
                encodeURIComponent(filename);

            await context.handleArchive(url, {}, response);

            return response;
        },

        cleanup() {
            fs.rmSync(temporaryRoot, {
                recursive: true,
                force: true,
            });
        },
    };
}

describe('Blink archive download security', function () {
    it('serves a regular MP4 file', async function () {
        const h = createHarness();

        try {
            const filename = 'valid.mp4';
            const file = path.join(h.actualRoot, filename);

            fs.writeFileSync(file, 'VALID-VIDEO');

            const response = await h.request(filename);

            assert.equal(response.status, 200);
            assert.equal(response.streamed, file);
        } finally {
            h.cleanup();
        }
    });

    it('rejects a symlink to a file outside the archive', async function () {
        const h = createHarness();

        try {
            const outside = path.join(h.external, 'outside.mp4');
            fs.writeFileSync(outside, 'EXTERNAL-VIDEO');

            fs.symlinkSync(
                outside,
                path.join(h.actualRoot, 'linked.mp4'),
            );

            const response = await h.request('linked.mp4');

            assert.equal(response.status, 404);
            assert.equal(response.streamed, null);
        } finally {
            h.cleanup();
        }
    });

    it('rejects a camera directory pointing outside', async function () {
        const h = createHarness(true);

        try {
            fs.writeFileSync(
                path.join(h.external, 'outside.mp4'),
                'EXTERNAL-VIDEO',
            );

            fs.symlinkSync(
                h.external,
                path.join(h.actualRoot, '12345_Testkamera'),
                'dir',
            );

            const response = await h.request('outside.mp4');

            assert.equal(response.status, 404);
            assert.equal(response.streamed, null);
        } finally {
            h.cleanup();
        }
    });

    it('allows the configured archive root to be a symlink', async function () {
        const h = createHarness(false, true);

        try {
            fs.writeFileSync(
                path.join(h.actualRoot, 'valid.mp4'),
                'VALID-VIDEO',
            );

            const response = await h.request('valid.mp4');

            assert.equal(response.status, 200);
            assert.ok(response.streamed);
        } finally {
            h.cleanup();
        }
    });

    it('rejects non-MP4 downloads', async function () {
        const h = createHarness();

        try {
            fs.writeFileSync(
                path.join(h.actualRoot, 'secret.txt'),
                'TEST-ONLY',
            );

            const response = await h.request('secret.txt');

            assert.equal(response.status, 403);
            assert.equal(response.streamed, null);
        } finally {
            h.cleanup();
        }
    });
});
