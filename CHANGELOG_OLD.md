# Older changelog entries

Older changelog entries that have been moved out of `README.md` will appear below.
This file is managed by [@alcalzone/release-script](https://github.com/AlCalzone/release-script)
when newer entries are added to the README.
## 0.0.32 (2026-07-10)
* Added optional video archive for downloaded MP4 clips on NAS.
* Added archive support to the camera grid.
* Backfilled existing local video files into the archive.
* Sorted and deduplicated archive clips in the camera grid.
* Added date/time labels for archive clips in the camera grid.

## 0.0.31 (2026-07-07)
* Improved German admin UI translations.

## 0.0.30 (2026-07-07)
* updated TypeScript dependencies

## 0.0.29 (2026-07-03)
* Updated ioBroker dependencies and aligned TypeScript configuration with Node.js 22.

## 0.0.28 (2026-07-03)
* Replaced remaining blink-api sleep helper with Node.js timer promises.

## 0.0.27 (2026-07-03)
* Replaced remaining blink-api sleep helper with Node.js timer promises.

## 0.0.26 (2026-07-03)
* Avoided direct process.exit() calls in the IMMI/HLS helper.
* Replaced custom LiveView sleep helper with Node.js timer promises.

## 0.0.25 (2026-07-02)
* fix: remove personal LiveView camera override.
* Translated remaining blink-api documentation comments to English.

## 0.0.24 (2026-07-02)
* Translated remaining runtime-visible helper error and debug messages to English.

## 0.0.23 (2026-07-02)
* Translated long admin i18n entries to avoid untranslated fallback warnings.

## 0.0.22 (2026-07-01)
* Fixed LiveView helper script version to use a numeric version string.
* Aligned the admin default for the live snapshot interval with the adapter default.

## 0.0.21 (2026-07-01)

* Fixed account ID discovery so `info.account_id` and camera `info.account_id` are populated again.
* Fixed Live Snapshot timer cleanup by clearing the recursive timeout correctly.
* Fixed missing notification settings in the admin UI for battery and motion alerts.
* Normalized new admin UI translations for Streaming and Notifications tabs.
* Removed unused admin translation keys after the Notifications tab restructuring.
* Translated remaining MJPEG server logs and comments to English.
* Translated remaining LiveView helper messages to English.
* Translated remaining LiveView web grid strings and comments to English.
* Removed a hardcoded fallback account ID from the LiveView web grid helper.

## 0.0.20 (2026-06-27)
* Fixed sensitive debug logging: PIN/2FA codes, passwords, tokens and authorization/cookie headers are now masked or omitted from debug logs.
* Added request timeouts for Blink cloud API requests to avoid hanging poll or login operations.
* Changed adapter logs, notifications, object names and Admin UI texts to English to comply with ioBroker repository requirements.
* Normalized Admin UI translations and added missing i18n keys.
* Fixed LiveView helper packaging so the required LiveView helper scripts are included in the adapter package.
* Fixed LiveView start handling for unsupported XT2/LFR cameras. Unsupported cameras are detected before starting the HLS bridge.
* Fixed LiveView status handling so the web grid only shows a running stream after the HLS playlist is actually available.
* Added documentation for supported Blink devices and manufacturer links.
* Added documentation for the optional LiveView web grid, including JavaScript adapter and ffmpeg requirements.
* Removed unused helper code and cleaned up repository checker findings.

## 0.0.19 (2026-06-24)
* (Pischleuder1) fix: handle unsupported XT2 live view and avoid early HLS state

## 0.0.18 (2026-06-15)
* (Pischleuder1) fix: expose Blink account id for LiveView helper (blink.0.info.account_id)

## 0.0.17 (2026-06-14)
* (Pischleuder) fix: avoid interactive Blink 2FA prompt in LiveView helper (LiveView not comming up)

## 0.0.16 (2026-06-13)
* (Pischleuder) fix: chaged roles and hierachy

## 0.0.15 (2026-06-13)
* (Pischleuder1) LiveView: Camera model recognition (XT/XT2 without LiveView)
* correct entry point for cameras
* fix: several cameras showing the same video

## 0.0.14 (2026-05-29)
* fixed some sync module busy errors

## 0.0.13 (2026-05-28)
* If video.history.* states still contain clip IDs but the corresponding MP4 files are missing, the history is no longer considered current.
* Missing or zero-byte history files are redownloaded during the next sync
* Reuse of old slots now occurs only if the old MP4 file actually exists and is larger than 0 bytes

## 0.0.12 (2026-05-28)
* USB/Local Storage manifest is checked first
* Cloud storage is now used only as a fallback
* More robust Local Storage matching: camera_id / cameraId / device_id / deviceId, if present in the manifest otherwise, camera names (trimmed and lowercased)

## 0.0.11 (2026-05-27)
* (Pischleuder1) maximal 3 login attempts to avoid locked account
* Video busy cooldown for HTTP 409 / code 307 error

## 0.0.10 (2026-05-23)
* (Pischleuder1) Fix trusted publisher case mismatch

## 0.0.9 (2026-05-23)
* (Pischleuder1) Use npm trusted publishing

## 0.0.8 (2026-05-23)
* (Pischleuder1) Fix deploy workflow

## 0.0.7 (2026-05-22)
* Adapter requires node.js >= 22 now
* added MJPEG streaming
* Supports Smart Detection states for classified motion events
* Supports cloud stored videos and local stored videos on sc-card

**Note:** For older changes, see [CHANGELOG_OLD.md](CHANGELOG_OLD.md).## License

MIT License

Copyright (c) 2026 Pischleuder1 <pischleuder@gmx.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 0.0.6 (2026-04-28)
* Blink PanTilt and Blink Mini - temperature_text and battery_text set to "not available" because of no built in temperature and battery indicator
* blink.0.xxx.xxx.status.wifi_strength fixed

## 0.0.5 (2026-04-27)
* new admin menu
* checkbox to turn log on/off

## 0.0.4 (2026-04-26)
* integrated Amazon Video Doorbell
* Log is now deleted after adapter restart

## 0.0.2 (2026-04-24)
* update language
* Updated Blink API integration and package metadata.

## 0.0.1 (2026-04-23)
* initial release
