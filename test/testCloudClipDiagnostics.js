'use strict';

// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('mocha');

describe('Blink cloud clip diagnostics', () => {
	it('reports clip ages and camera matches without leaking video URLs', async () => {
		const source = fs.readFileSync(path.join(__dirname, '../lib/blink-api.js'), 'utf8');

		const start = source.indexOf('async function getCloudClips(');
		const end = source.indexOf('\n/**\n * Downloads a cloud clip', start);

		assert.ok(start >= 0);
		assert.ok(end > start);

		const logs = [];
		const requests = [];

		const responses = [
			{
				media: [
					{
						id: 'SECRET_CLIP_1',
						camera_id: 123,
						created_at: '2026-11-19T20:20:19Z',
						media: 'https://example.invalid/SECRET_VIDEO_1',
					},
					{
						id: 'SECRET_CLIP_2',
						camera_id: 123,
						created_at: '2026-11-26T18:30:00Z',
						media: 'https://example.invalid/SECRET_VIDEO_2',
					},
					{
						id: 'OTHER_CAMERA_CLIP',
						camera_id: 999,
						created_at: '2026-11-25T10:00:00Z',
					},
				],
			},
			{
				media: [
					{
						id: 'SECRET_CLIP_3',
						camera_id: 123,
						created_at: '2026-11-24T12:00:00Z',
						media: 'https://example.invalid/SECRET_VIDEO_3',
					},
				],
			},
			{ media: [] },
		];

		const context = {
			_getAccountId: async () => 456,
			_restGet: async request => {
				requests.push(request);
				return responses[requests.length - 1];
			},
			firstDefined: (...values) =>
				values.find(value => value !== null && value !== undefined && value !== '') ?? null,
			dbg: message => logs.push(String(message)),
		};

		const getCloudClips = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);

		const result = await getCloudClips(
			{ accessToken: 'SECRET_TOKEN', apiHost: 'example.invalid' },
			789,
			123,
			'Testkamera',
			10,
		);

		assert.equal(result.source, 'cloud');
		assert.equal(result.clips.length, 3);

		assert.deepEqual(
			Array.from(result.clips, clip => clip.id),
			['SECRET_CLIP_2', 'SECRET_CLIP_3', 'SECRET_CLIP_1'],
		);

		assert.equal(requests.length, 3);

		const diagnostics = logs.filter(line => line.includes('CLOUD CLIPS DIAG'));

		assert.equal(diagnostics.length, 2);

		assert.match(diagnostics[0], /total=3/);
		assert.match(diagnostics[0], /cameraMatches=2/);
		assert.match(diagnostics[0], /oldest=2026-11-19T20:20:19.000Z/);
		assert.match(diagnostics[0], /newest=2026-11-26T18:30:00.000Z/);
		assert.match(diagnostics[0], /responseKeys=/);

		for (const line of diagnostics) {
			assert.ok(!line.includes('SECRET_TOKEN'));
			assert.ok(!line.includes('SECRET_VIDEO'));
			assert.ok(!line.includes('SECRET_CLIP'));
			assert.ok(!line.includes('example.invalid'));
		}

		console.log('Cloud-Diagnose: Zeitstempel, Kamera-Filter, ' + 'Paginierung und Datenschutz OK');
	});
});
