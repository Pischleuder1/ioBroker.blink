# Older changelog entries

Older changelog entries that have been moved out of `README.md` will appear below.
This file is managed by [@alcalzone/release-script](https://github.com/AlCalzone/release-script)
when newer entries are added to the README.
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
