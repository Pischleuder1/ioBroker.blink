'use strict';

// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('mocha');

const source = fs.readFileSync(path.join(__dirname, '../lib/blink-api.js'), 'utf8');

const start = source.indexOf('async function getHistoryClips(');
const end = source.indexOf('\n}\n', start);

assert.ok(start >= 0);
assert.ok(end > start);

const functionSource = source.slice(start, end + 2);

const manifest = {
	manifestId: 'manifest-test',
	clips: [
		{
			id: 'local-old',
			camera_name: 'Camera A',
			created_at: '2026-11-25T10:00:00Z',
		},
		{
			id: 'other-camera',
			camera_name: 'Camera B',
			created_at: '2026-11-27T12:00:00Z',
		},
		{
			id: 'local-new',
			camera_name: 'Camera A',
			created_at: '2026-11-27T10:00:00Z',
		},
	],
};

/**
 * @param {object|null} cloudResult
 * @param {Error|null} [cloudError]
 */
function createTest(cloudResult, cloudError = null) {
	const calls = {
		cloud: 0,
		local: 0,
	};

	const context = {
		getV4CloudClips: async () => {
			calls.cloud++;

			if (cloudError) {
				throw cloudError;
			}

			return cloudResult;
		},

		getLocalStorageClips: async () => {
			calls.local++;
			return manifest;
		},

		dbg: () => {},
	};

	const getHistoryClips = vm.runInNewContext(`(${functionSource})`, context);

	return { getHistoryClips, calls };
}

const session = {
	accessToken: 'TEST_TOKEN',
	apiHost: 'example.invalid',
};

const opts = {
	syncId: 456,
	limit: 2,
};

describe('Blink v4 history local-storage fallback', () => {
	it('uses local clips when cloud is empty', async () => {
		const test = createTest({
			clips: [],
			source: 'cloud',
		});

		const result = await test.getHistoryClips(session, 789, 123, 'Camera A', opts);

		assert.equal(result.source, 'local_storage');
		assert.equal(result.manifestId, 'manifest-test');

		assert.deepEqual(
			Array.from(result.clips, clip => clip.id),
			['local-new', 'local-old'],
		);

		assert.equal(test.calls.cloud, 1);
		assert.equal(test.calls.local, 1);
	});

	it('uses local clips when cloud API fails', async () => {
		const test = createTest(null, new Error('Simulated cloud API failure'));

		const result = await test.getHistoryClips(session, 789, 123, 'Camera A', opts);

		assert.equal(result.source, 'local_storage');
		assert.equal(result.clips.length, 2);
		assert.equal(result.clips[0].id, 'local-new');

		assert.equal(test.calls.cloud, 1);
		assert.equal(test.calls.local, 1);
	});

	it('keeps cloud priority when clips are available', async () => {
		const test = createTest({
			clips: [
				{
					id: 'cloud-current',
					created_at: '2026-11-27T15:00:00Z',
				},
			],
			source: 'cloud',
		});

		const result = await test.getHistoryClips(session, 789, 123, 'Camera A', opts);

		assert.equal(result.source, 'cloud');
		assert.equal(result.clips[0].id, 'cloud-current');

		assert.equal(test.calls.cloud, 1);
		assert.equal(test.calls.local, 0);
	});

	it('returns none if cloud is empty and no sync module exists', async () => {
		const test = createTest({
			clips: [],
			source: 'cloud',
		});

		const result = await test.getHistoryClips(session, 789, 123, 'Camera A', { limit: 2 });

		assert.equal(result.source, 'none');
		assert.equal(result.clips.length, 0);

		assert.equal(test.calls.cloud, 1);
		assert.equal(test.calls.local, 0);
	});
});
