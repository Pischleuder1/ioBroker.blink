'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

describe('Blink archive filename collision safety', function () {
    it('preserves an existing video and chooses another UUID', async function () {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'blink-collision-test-'),
        );

        try {
            const archiveDir = path.join(root, 'archive');
            const cameraDir = path.join(
                archiveDir,
                '12345_Testkamera',
            );

            fs.mkdirSync(cameraDir, { recursive: true });

            const input = path.join(root, 'source.mp4');
            const originalContent = Buffer.from('EXISTING-VIDEO');
            const newContent = Buffer.from('DIFFERENT-VIDEO');

            fs.writeFileSync(input, newContent);

            const hash = crypto.createHash('sha256')
                .update(newContent)
                .digest('hex');

            const existingUuid =
                '550e8400-e29b-41d4-a716-446655440000';

            const temporaryUuid =
                '660e8400-e29b-41d4-a716-446655440000';

            const alternativeUuid =
                '770e8400-e29b-41d4-a716-446655440000';

            const prefix =
                '2026-11-28T13-30-00-000+0100_' +
                '12345_cloud_sha256-' + hash +
                '_archive-';

            const suffix = '_111111.mp4';

            const existingFile = path.join(
                cameraDir,
                prefix + existingUuid + suffix,
            );

            fs.writeFileSync(
                existingFile,
                originalContent,
            );

            // Deterministic UUID sequence:
            // temporary file, colliding final name,
            // then an alternative final name.
            const uuids = [
                temporaryUuid,
                existingUuid,
                alternativeUuid,
            ];

            const testCrypto = {
                createHash: crypto.createHash,
                randomUUID() {
                    assert.ok(
                        uuids.length > 0,
                        'Unexpected UUID request',
                    );

                    return uuids.shift();
                },
            };

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
                {
                    fs,
                    path,
                    crypto: testCrypto,
                },
            );

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
                    return String(value || '')
                        .replace(/[^a-zA-Z0-9_-]/g, '_');
                },

                archiveTimestamp() {
                    return '2026-11-28T13-30-00-000+0100';
                },

                isUsableFile(file) {
                    try {
                        return fs.statSync(file).size > 0;
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

            await adapter.archiveVideo('12345', {
                file: input,
                id: '111111',
                source: 'cloud',
                created_at: '2026-11-28T12:30:00.000Z',
            });

            // Existing file must remain byte-for-byte unchanged.
            assert.deepEqual(
                fs.readFileSync(existingFile),
                originalContent,
            );

            const newFile = path.join(
                cameraDir,
                prefix + alternativeUuid + suffix,
            );

            assert.deepEqual(
                fs.readFileSync(newFile),
                newContent,
            );

            const files = fs.readdirSync(cameraDir);

            assert.equal(
                files.filter(name => name.endsWith('.mp4')).length,
                2,
            );

            assert.equal(
                files.filter(name =>
                    name.endsWith('.blink-archive.tmp')
                ).length,
                0,
            );

            assert.equal(warnings.length, 0);
            assert.equal(uuids.length, 0);

            console.log('Bestehende Datei unverändert: OK');
            console.log('Alternative UUID verwendet: OK');
            console.log('Keine temporären Reste: OK');
        } finally {
            fs.rmSync(root, {
                recursive: true,
                force: true,
            });
        }
    });
});
