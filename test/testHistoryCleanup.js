'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { describe, it } = require('mocha');

const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

describe('Blink history cleanup protection', () => {
	it('preserves history files and backups while cleaning expired snapshots', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-history-cleanup-'));

		const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
		const recentDate = new Date(Date.now() - 10 * 60 * 1000);

		function createFile(name, date) {
			const file = path.join(dir, name);
			fs.writeFileSync(file, `content-${name}`);
			fs.utimesSync(file, date, date);
			return file;
		}

		const history = createFile('camera_history_0.mp4', oldDate);
		const historyOther = createFile('camera_history_9.mp4', oldDate);
		const temp = createFile('.camera_history_0.tmp.mp4', oldDate);
		const latest = createFile('camera_latest.mp4', oldDate);
		const snapshot = createFile('snapshot.jpg', oldDate);
		const recent = createFile('aktuell.jpg', recentDate);

		const backupDir = path.join(dir, '.blink-history-backup-camera-test');

		fs.mkdirSync(backupDir);
		const backupFile = path.join(backupDir, '0.mp4');
		fs.writeFileSync(backupFile, 'original-video');

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

		const mod = {
			exports: /** @type {any} */ ({}),
		};

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

			adapter.cfg = {
				snapshotDir: dir,
				maxSnapshotAgeHours: 1,
			};

			adapter.cleanupSnapshots();

			// History-Videos bleiben erhalten.
			assert.equal(fs.existsSync(history), true);
			assert.equal(fs.existsSync(historyOther), true);

			// Temporäre History-Dateien bleiben unangetastet.
			assert.equal(fs.existsSync(temp), true);

			// Reguläre abgelaufene Dateien werden gelöscht.
			assert.equal(fs.existsSync(latest), false);
			assert.equal(fs.existsSync(snapshot), false);

			// Aktuelle Snapshots bleiben erhalten.
			assert.equal(fs.existsSync(recent), true);

			// Backups werden nicht verändert.
			assert.equal(fs.existsSync(backupDir), true);
			assert.equal(fs.readFileSync(backupFile, 'utf8'), 'original-video');

			assert.equal(fs.readFileSync(history, 'utf8'), 'content-camera_history_0.mp4');
		} finally {
			fs.rmSync(dir, {
				recursive: true,
				force: true,
			});
		}
	});
});
