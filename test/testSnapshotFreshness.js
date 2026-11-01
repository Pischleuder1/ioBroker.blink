'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { describe, it } = require('mocha');

const source = fs.readFileSync(
    path.join(__dirname, '../lib/blink-api.js'),
    'utf8',
);

const createFixture = (thumbnails, imageResponses = null, deviceGroup = 'cameras') => {
    let clock = Date.now();

    const stats = {
        homescreen: 0,
        posts: 0,
        postPaths: [],
        downloads: 0,
        baselineDownloads: 0,
        downloadPath: '',
    };

    const jpeg = Buffer.from('simulated-new-jpeg');

    class FakeDate extends Date {
        static now() {
            return clock;
        }
    }

    const https = {
        request(options, callback) {
            const request = new EventEmitter();

            request.setTimeout = () => {};
            request.write = () => {};

            request.end = () => {
                let responseBody;
            let statusCode = 200;

                if (
                    options.method === 'GET' &&
                    options.path.includes('/homescreen')
                ) {
                    const index = Math.min(
                        stats.homescreen,
                        thumbnails.length - 1,
                    );

                    const thumbnail = thumbnails[index];
                    stats.homescreen++;

                    if (
                        thumbnail &&
                        typeof thumbnail === 'object' &&
                        thumbnail.httpStatus
                    ) {
                        statusCode = thumbnail.httpStatus;
                    }

                    const homescreen = {
                        cameras: [],
                        owls: [],
                        doorbells: [],
                    };

                    if (!Object.hasOwn(homescreen, deviceGroup)) {
                        throw new Error('Invalid device group');
                    }

                    homescreen[deviceGroup] = [{
                        device: { id: 42 },
                        camera_status: { thumbnail },
                    }];

                    responseBody = Buffer.from(
                        JSON.stringify(homescreen),
                    );
                } else if (
                    options.method === 'POST' &&
                    options.path.includes('/thumbnail')
                ) {
                    stats.posts++;
                    stats.postPaths.push(options.path);
                    responseBody = Buffer.from('{}');
                } else if (options.method === 'GET') {
                    const baseline = stats.posts === 0;

                    if (baseline) {
                        stats.baselineDownloads++;
                    } else {
                        stats.downloads++;
                    }

                    stats.downloadPath = options.path;

                    if (options.path.includes('/unavailable.jpg')) {
                        statusCode = 503;
                        responseBody = Buffer.from('Image unavailable');
                    } else if (Array.isArray(imageResponses)) {
                        const index = Math.min(
                            stats.downloads,
                            imageResponses.length - 1,
                        );
                        responseBody = imageResponses[index];
                    } else {
                        responseBody = baseline
                            ? Buffer.from('simulated-previous-jpeg')
                            : jpeg;
                    }
                } else {
                    throw new Error(
                        `Unexpected request: ${options.method} ${options.path}`,
                    );
                }

                process.nextTick(() => {
                    const response = new EventEmitter();

                    response.statusCode = statusCode;
                    response.headers = {};

                    callback(response);
                    response.emit('data', responseBody);
                    response.emit('end');
                });
            };

            return request;
        },
    };

    const mockRequire = name => {
        if (name === 'node:https') {
            return https;
        }

        if (name === 'node:timers/promises') {
            return {
                setTimeout: async ms => {
                    clock += ms;
                },
            };
        }

        return require(name);
    };

    const mod = { exports: {} };

    vm.runInNewContext(
        source,
        {
            module: mod,
            exports: mod.exports,
            require: mockRequire,
            process,
            Buffer,
            URL,
            URLSearchParams,
            Date: FakeDate,
            console,
        },
        {
            filename: 'lib/blink-api.js',
            timeout: 3000,
        },
    );

    const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blink-issue56-'),
    );

    return {
        api: mod.exports,
        stats,
        jpeg,
        file: path.join(dir, 'snapshot.jpg'),
        cleanup: () => fs.rmSync(dir, {
            recursive: true,
            force: true,
        }),
    };
};

const requestSnapshot = (fixture, info = {}, apiType = 'camera') =>
    fixture.api.snapshot(
        {
            _accountId: 123,
            accessToken: 'test-token',
            apiHost: 'example.invalid',
        },
        7,
        42,
        '/old-thumbnail',
        fixture.file,
        apiType,
        info,
    );

describe('Issue #56: Fresh Blink snapshots', () => {
    it('waits for a changed thumbnail and preserves its timestamp', async () => {
        const captured = Math.floor(
            (Date.now() - 10000) / 1000,
        );

        const old = '/images/old?ts=1700000000';
        const fresh = `/images/new?ts=${captured}`;

        const fixture = createFixture([
            old,
            old,
            old,
            fresh,
        ]);

        try {
            const info = {};

            await requestSnapshot(fixture, info);

            assert.equal(fixture.stats.posts, 1);
            assert.equal(fixture.stats.homescreen, 4);
            assert.equal(fixture.stats.downloads, 1);

            assert.equal(
                fixture.stats.downloadPath,
                `/images/new.jpg?ts=${captured}`,
            );

            assert.deepEqual(
                fs.readFileSync(fixture.file),
                fixture.jpeg,
            );

            assert.equal(
                info.capturedAt,
                new Date(captured * 1000).toISOString(),
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('does not overwrite a previous image on timeout', async () => {
        const old = '/images/old?ts=1700000000';
        const fixture = createFixture([old]);

        try {
            fs.writeFileSync(
                fixture.file,
                Buffer.from('existing-picture'),
            );

            await assert.rejects(
                requestSnapshot(fixture),
                /thumbnail did not change within 60s/,
            );

            assert.equal(
                fs.readFileSync(fixture.file, 'utf8'),
                'existing-picture',
            );

            assert.equal(fixture.stats.downloads, 0);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects a missing baseline without triggering a snapshot', async () => {
        const fixture = createFixture([null]);

        try {
            await assert.rejects(
                requestSnapshot(fixture),
                /no baseline thumbnail available/,
            );

            assert.equal(fixture.stats.posts, 0);
            assert.equal(fixture.stats.downloads, 0);
        } finally {
            fixture.cleanup();
        }
    });

    it('does not invent a timestamp when ts is absent', async () => {
        const fixture = createFixture([
            '/images/old',
            '/images/new',
        ]);

        try {
            const info = {};

            await requestSnapshot(fixture, info);

            assert.equal(info.capturedAt, null);
            assert.equal(fixture.stats.downloads, 1);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects an implausibly old timestamp', async () => {
        const fixture = createFixture([
            '/images/old?ts=1700000000',
            '/images/new?ts=1000000000',
        ]);

        try {
            const info = {};

            await requestSnapshot(fixture, info);

            assert.equal(info.capturedAt, null);
        } finally {
            fixture.cleanup();
        }
    });

    it('supports a millisecond timestamp', async () => {
        const captured = Date.now() - 10000;

        const fixture = createFixture([
            '/images/old?ts=1700000000',
            `/images/new?ts=${captured}`,
        ]);

        try {
            const info = {};

            await requestSnapshot(fixture, info);

            assert.equal(
                info.capturedAt,
                new Date(captured).toISOString(),
            );
        } finally {
            fixture.cleanup();
        }
    });
});


describe('Issue #56: live.timestamp integration', () => {
    const mainSource = fs.readFileSync(
        path.join(__dirname, '../main.js'),
        'utf8',
    );

    const createAdapter = () => {
        class MockAdapter extends EventEmitter {
            constructor() {
                super();
                this.namespace = 'blink.0';
            }
        }

        const mockRequire = name => {
            if (name === '@iobroker/adapter-core') {
                return { Adapter: MockAdapter };
            }
            if (name === './lib/blink-api') {
                return {};
            }
            if (name === './lib/mjpeg-server') {
                return { MjpegServer: class {} };
            }
            return require(name);
        };

        const mod = { exports: {} };

        vm.runInNewContext(
            mainSource,
            {
                module: mod,
                require: mockRequire,
                Buffer,
            },
            {
                filename: 'main.js',
                timeout: 3000,
            },
        );

        const adapter = mod.exports();
        const states = new Map();

        adapter.cfg = {
            storeBase64: false,
        };

        adapter.setStateAsync = async (
            id,
            value,
            ack,
        ) => {
            states.set(id, { value, ack });
        };

        const published = [];

        adapter.publishSnapshotToStorage = async (devId, file) => {
            published.push({ devId, file });
        };

        return { adapter, states, published };
    };

    it('stores the confirmed capture time', async () => {
        const { adapter, states, published } = createAdapter();

        const capturedAt = '2026-10-30T15:29:24.000Z';

        await adapter.setLiveStates(
            '42',
            '/tmp/test-snapshot.jpg',
            capturedAt,
        );

        const timestamp = states.get(
            'cameras.42.live.timestamp',
        );

        assert.equal(timestamp.value, capturedAt);
        assert.equal(timestamp.ack, true);

        assert.deepEqual(published, [{
            devId: '42',
            file: '/tmp/test-snapshot.jpg',
        }]);
    });

    it('does not invent a timestamp when unavailable', async () => {
        const { adapter, states, published } = createAdapter();

        await adapter.setLiveStates(
            '42',
            '/tmp/test-snapshot.jpg',
            null,
        );

        const timestamp = states.get(
            'cameras.42.live.timestamp',
        );

        assert.equal(timestamp.value, '');
        assert.equal(timestamp.ack, true);

        assert.deepEqual(published, [{
            devId: '42',
            file: '/tmp/test-snapshot.jpg',
        }]);
    });

    it('writes the JPEG to ioBroker VIS storage', async () => {
        const { adapter, states } = createAdapter();

        // Echte Methode verwenden statt der Testsimulation.
        delete adapter.publishSnapshotToStorage;

        const folder = fs.mkdtempSync(
            path.join(os.tmpdir(), 'blink-vis-test-'),
        );

        const file = path.join(folder, 'snapshot.jpg');
        const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

        const writes = [];
        const warnings = [];

        adapter.log = {
            warn: message => warnings.push(message),
        };

        adapter.writeFileAsync = async (id, name, data) => {
            writes.push({ id, name, data });
        };

        try {
            fs.writeFileSync(file, image);

            await adapter.setLiveStates(
                '42',
                file,
                '2026-10-30T15:29:24.000Z',
            );

            assert.equal(writes.length, 1);
            assert.equal(writes[0].id, 'blink.0.storage');
            assert.equal(
                writes[0].name,
                'snapshots/42_live.jpg',
            );
            assert.deepEqual(writes[0].data, image);

            const url = states.get(
                'cameras.42.live.image_url',
            );

            assert.ok(url);

            assert.match(
                url.value,
                /^\/blink\.0\.storage\/snapshots\/42_live\.jpg\?t=\d+$/,
            );

            assert.equal(
                states.get('cameras.42.live.timestamp').value,
                '2026-10-30T15:29:24.000Z',
            );

            assert.equal(warnings.length, 0);
        } finally {
            fs.rmSync(folder, {
                recursive: true,
                force: true,
            });
        }
    });

    it('preserves snapshot states if VIS storage fails', async () => {
        const { adapter, states } = createAdapter();

        delete adapter.publishSnapshotToStorage;

        const folder = fs.mkdtempSync(
            path.join(os.tmpdir(), 'blink-vis-error-test-'),
        );

        const file = path.join(folder, 'snapshot.jpg');
        const warnings = [];

        adapter.log = {
            warn: message => warnings.push(message),
        };

        adapter.writeFileAsync = async () => {
            throw new Error('Storage unavailable');
        };

        try {
            fs.writeFileSync(
                file,
                Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
            );

            await adapter.setLiveStates(
                '42',
                file,
                '2026-10-30T15:29:24.000Z',
            );

            assert.equal(
                states.get('cameras.42.live.timestamp').value,
                '2026-10-30T15:29:24.000Z',
            );

            assert.equal(warnings.length, 1);

            assert.match(
                warnings[0],
                /VIS snapshot storage failed/,
            );

            assert.equal(
                states.has('cameras.42.live.image_url'),
                false,
            );
        } finally {
            fs.rmSync(folder, {
                recursive: true,
                force: true,
            });
        }
    });

});


describe('Issue #56: Blink API failure handling', () => {
    it('recovers from a temporary homescreen error', async () => {
        const fixture = createFixture([
            '/images/old',
            { httpStatus: 503 },
            '/images/old',
            '/images/new',
        ]);

        try {
            await requestSnapshot(fixture);

            assert.equal(fixture.stats.homescreen, 4);
            assert.equal(fixture.stats.posts, 1);
            assert.equal(fixture.stats.downloads, 1);

            assert.equal(
                fixture.stats.downloadPath,
                '/images/new.jpg',
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('does not trigger a snapshot when baseline fails', async () => {
        const fixture = createFixture([
            { httpStatus: 503 },
        ]);

        try {
            await assert.rejects(
                requestSnapshot(fixture),
                /HTTP 503/,
            );

            assert.equal(fixture.stats.posts, 0);
            assert.equal(fixture.stats.downloads, 0);
        } finally {
            fixture.cleanup();
        }
    });

    it('preserves an existing image if download fails', async () => {
        const fixture = createFixture([
            '/images/old',
            '/images/unavailable',
        ]);

        try {
            fs.writeFileSync(
                fixture.file,
                Buffer.from('previous-image'),
            );

            await assert.rejects(
                requestSnapshot(fixture),
                /HTTP 503/,
            );

            assert.equal(
                fs.readFileSync(fixture.file, 'utf8'),
                'previous-image',
            );

            assert.equal(
                fixture.stats.downloads,
                30,
                'Failed JPEG downloads must be retried until timeout',
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('handles JPEG URLs with encoded ISO timestamps', async () => {
        const captured = new Date(
            Date.now() - 10000,
        ).toISOString();

        const encoded = encodeURIComponent(captured);

        const fixture = createFixture([
            '/images/old.jpeg',
            `/images/new.jpeg?ts=${encoded}`,
        ]);

        try {
            const info = {};

            await requestSnapshot(fixture, info);

            assert.equal(
                fixture.stats.downloadPath,
                `/images/new.jpeg?ts=${encoded}`,
            );

            assert.equal(info.capturedAt, captured);
        } finally {
            fixture.cleanup();
        }
    });
});


describe('Issue #56: delayed image availability', () => {
    it('URL changes before JPEG content is ready', async () => {
        const captured = Math.floor(Date.now() / 1000);

        const previousImage = Buffer.from('previous-image');
        const newImage = Buffer.from('fresh-image');

        const fixture = createFixture(
            [
                '/images/camera?ts=1700000000',
                `/images/camera?ts=${captured}`,
            ],
            [
                previousImage,
                previousImage,
                newImage,
            ],
        );

        try {
            fs.writeFileSync(fixture.file, previousImage);

            const info = {};

            await requestSnapshot(fixture, info);

            assert.equal(
                fixture.stats.downloads,
                2,
                'The adapter must retry when JPEG bytes are unchanged',
            );

            assert.deepEqual(
                fs.readFileSync(fixture.file),
                newImage,
                'Only the fresh JPEG may replace the existing file',
            );

            assert.equal(
                info.capturedAt,
                new Date(captured * 1000).toISOString(),
            );
        } finally {
            fixture.cleanup();
        }
    });
});


describe('Issue #56: additional camera and content checks', () => {
    it('keeps the old image when URL changes but JPEG never does', async () => {
        const previousImage = Buffer.from('unchanged-jpeg');

        const fixture = createFixture(
            [
                '/images/old?ts=1700000000',
                `/images/old?ts=${Math.floor(Date.now() / 1000)}`,
            ],
            [
                previousImage,
                previousImage,
            ],
        );

        try {
            fs.writeFileSync(fixture.file, previousImage);

            await assert.rejects(
                requestSnapshot(fixture),
                /JPEG content remained unchanged/,
            );

            assert.equal(fixture.stats.downloads, 30);

            assert.deepEqual(
                fs.readFileSync(fixture.file),
                previousImage,
            );
        } finally {
            fixture.cleanup();
        }
    });

    for (const [apiType, deviceGroup, endpoint] of [
        ['mini', 'owls', '/owls/42/thumbnail'],
        ['doorbell', 'doorbells', '/doorbells/42/thumbnail'],
    ]) {
        it(`supports ${apiType} snapshot refresh`, async () => {
            const fixture = createFixture(
                ['/images/old', '/images/new'],
                null,
                deviceGroup,
            );

            try {
                await requestSnapshot(
                    fixture,
                    {},
                    apiType,
                );

                assert.equal(fixture.stats.posts, 1);

                assert.ok(
                    fixture.stats.postPaths[0].includes(endpoint),
                );

                assert.equal(fixture.stats.downloads, 1);

                assert.deepEqual(
                    fs.readFileSync(fixture.file),
                    fixture.jpeg,
                );
            } finally {
                fixture.cleanup();
            }
        });
    }
});
