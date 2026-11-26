'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { describe, it } = require('mocha');

const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

describe('Blink corrupt cloud history filtering', () => {
	it('updates valid clips while skipping a corrupt clip', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-history-filter-'));

		const devId = 'filter-camera';
		const camera = {
			id: devId,
			name: 'Filter Camera',
			network_id: 'network-filter',
		};

		const clips = ['clip-A', 'clip-B', 'clip-C'].map((id, i) => ({
			id,
			created_at: new Date(Date.UTC(2026, 10, 26, 18, 0, 0) - i * 60000).toISOString(),
			_cloudUrl: `https://example.invalid/${id}.mp4`,
		}));

		const attempts = [];
		const states = new Map();

		const base = `cameras.${devId}.video.history`;

		const slot = i => path.join(dir, `${devId}_history_${i}.mp4`);

		// Bestehende History, die beim ersten Fehler erhalten bleiben muss.
		fs.writeFileSync(slot(0), 'old-video');

		states.set(`${base}.0.id`, 'old-clip');
		states.set(`${base}.0.file`, slot(0));

		const api = {
			getHistoryClips: async () => ({
				source: 'cloud',
				clips,
			}),

			downloadCloudClip: async (_session, clip, destination) => {
				attempts.push(clip.id);

				if (clip.id === 'clip-B') {
					const error = /** @type {Error & {statusCode?: number}} */ (
						new Error('HTTP 400: {"code":723,"message":"Media corrupt"}')
					);
					error.statusCode = 400;
					throw error;
				}

				fs.writeFileSync(destination, `video-${clip.id}`);

				return {
					ok: true,
					file: destination,
					clipId: clip.id,
				};
			},
		};

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
				return api;
			}

			if (name === './lib/mjpeg-server') {
				return { MjpegServer: class {} };
			}

			return require(name);
		};

		const mod = { exports: /** @type {any} */ ({}) };

		try {
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

			adapter.session = {};
			adapter.cfg = { snapshotDir: dir };
			adapter.findSyncIdForNetwork = () => null;

			adapter.log = {
				debug() {},
				info() {},
				warn() {},
				error() {},
			};

			adapter.getStateAsync = async key => ({
				val: states.get(key) ?? '',
			});

			adapter.setStateAsync = async (key, value) => {
				states.set(key, value);
			};

			// Erster Lauf: Clip B löst Fehler 723 aus.
			await adapter.syncCameraHistory(camera, devId);

			assert.equal(fs.readFileSync(slot(0), 'utf8'), 'old-video');
			assert.equal(states.get(`${base}.0.id`), 'old-clip');
			assert.deepEqual(attempts, ['clip-A', 'clip-B']);

			// Zweiter Lauf: Clip B befindet sich im Cooldown.
			await adapter.syncCameraHistory(camera, devId);

			assert.equal(fs.readFileSync(slot(0), 'utf8'), 'video-clip-A');
			assert.equal(fs.readFileSync(slot(1), 'utf8'), 'video-clip-C');

			assert.equal(states.get(`${base}.0.id`), 'clip-A');
			assert.equal(states.get(`${base}.1.id`), 'clip-C');

			assert.deepEqual(attempts, ['clip-A', 'clip-B', 'clip-A', 'clip-C']);

			const remainingTemp = fs.readdirSync(dir).filter(name => name.endsWith('.tmp.mp4'));

			assert.deepEqual(remainingTemp, []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
