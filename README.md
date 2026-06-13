![Logo](admin/blink.png)
# ioBroker.blink

[![NPM version](https://img.shields.io/npm/v/iobroker.blink.svg)](https://www.npmjs.com/package/iobroker.blink)
[![Downloads](https://img.shields.io/npm/dm/iobroker.blink.svg)](https://www.npmjs.com/package/iobroker.blink)
![Number of Installations](https://iobroker.live/badges/blink-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/blink-stable.svg)



## blink adapter for ioBroker

ioBroker adapter for Blink cameras.

## Getting started

Install via the ioBroker Admin interface
-----------------------------------------------------------------------------------------
Fill out your credentials:
<img width="2356" height="880" alt="image" src="https://github.com/user-attachments/assets/cdc22784-309f-4514-bfe4-abb93625958c" />
-----------------------------------------------------------------------------------------
<img width="2364" height="1044" alt="image" src="https://github.com/user-attachments/assets/fc9e9a79-f512-4675-b0f0-e6a998a91894" />
-----------------------------------------------------------------------------------------



## Developer manual

## Features

- Connects to the Blink Cloud
- Polls camera and sync module status
- Supports manual snapshots
- Stores live snapshots
- Downloads the latest available cloud video
- Allows enabling or disabling motion detection
- Supports battery warning states and notifications
- Supports Smart Detection states for classified motion events (works only on paid cloud services)
- Supports cloud stored videos and local stored videos on sd-card (SyncModule 2 and XR) via local server on port 8085 - JavaScript needed, see below !
- The script requires ffmpeg installed and a lot resources if you have a lot cameras and is then only partially suitable for Raspberry Pis (min. 4GB — more is better)
- initial release for live view with javascript for each camera - required javascript is installed automatically - except for the old XT2, because it uses a different video stream
<img width="1388" height="414" alt="image" src="https://github.com/user-attachments/assets/f6446647-c3d5-4cc2-b7e7-1b2a3686424a" />



## Blink Adapter: Datapoints

Overview of all datapoints provided by the customized ioBroker adapter `blink.0`.
Status: after refactoring for cloud history + local-storage fallback.

## Conventions

- `<CamID>` — numeric camera ID (e.g. `1754227`). Also used in the MP4 filename.
- `<NetID>` — Network ID of the sync module / home network (e.g. `174553`).
- `<N>` — slot index of the video history, **0 = newest** clip, **9 = oldest**.

All MP4 and snapshot files are stored in the configured snapshot directory (default: `/opt/iobroker/iobroker-data/blink/`).

---

## Adapter globals

| Datapoint | Type | Description |
|---|---|---|
| `blink.0.info.connection` | boolean | `true` if the adapter has a valid session to the Blink cloud. |

---

## Camera datapoints

Each camera gets its own channel `blink.0.cameras.<CamID>` with the following sub-structures.

### `info` – Master data

| Datapoint | Type | Description |
|---|---|---|
| `info.name` | string | Display name from the Blink app (e.g. "Driveway", "Patio"). |
| `info.network_id` | number | Network ID the camera belongs to. |
| `info.serial` | string | Camera serial number. |

### `status` – Current sensor state

| Datapoint | Type | Description |
|---|---|---|
| `status.armed` | boolean | Camera armed (follows the network mode). |
| `status.battery` | string | Battery status as text from the Blink app (e.g. `ok`, `low`). |
| `status.battery_raw` | number | Raw sensor value before conversion. |
| `status.battery_text` | string | Human-readable status text. |
| `status.battery_volt` | number | Battery voltage in volts. |
| `status.temperature` | number | Temperature at the camera sensor in °C. |
| `status.temperature_f` | number | Temperature in °F. |
| `status.temperature_text` | string | Temperature as formatted text. |
| `status.wifi_strength` | number | Wi-Fi signal strength (scale depends on model, higher = better). |
| `status.motion_detect_enabled` | boolean | Motion detection on the camera enabled/disabled. |
| `status.last_update` | string | Timestamp of the last status refresh (ISO format). |

#### Smart detection (only with active Blink subscription)

Extracted from the **newest cloud clip** of the camera:

| Datapoint | Type | Description |
|---|---|---|
| `status.smart_detection` | boolean | At least one smart-detect hit present in the last clip. |
| `status.smart_detection_raw` | string | Raw smart-detection payload (JSON, truncated). |
| `status.detection_type` | string | Comma-separated list of detected types. |
| `status.motion_source` | string | Trigger for the clip: `pir`, `cv_motion`, etc. |
| `status.person_detected` | boolean | Person detected. |
| `status.vehicle_detected` | boolean | Vehicle detected. |
| `status.animal_detected` | boolean | Animal detected. |
| `status.package_detected` | boolean | Package detected. |

### `battery` – Extended battery status

Used to avoid repeated notifications.

| Datapoint | Type | Description |
|---|---|---|
| `battery.low` | boolean | Battery is critically low. |
| `battery.warningSent` | boolean | A warning has already been issued (deduplication). |
| `battery.lastMessage` | string | Timestamp of the last status message. |
| `battery.lastWarning` | string | Timestamp of the last warning. |

### `live` – Snapshot and live stream

| Datapoint | Type | Description |
|---|---|---|
| `live.file` | string | Absolute path of the latest snapshot on disk. |
| `live.image_base64` | string | Snapshot as Base64 string (for direct embedding in VIS without file access). |
| `live.mime_type` | string | MIME type of the snapshot (e.g. `image/jpeg`). |
| `live.timestamp` | string | Snapshot timestamp (ISO). |
| `live.stream_active` | boolean | Live stream currently active. |
| `live.stream_url` | string | URL of the active live stream (TTL limited). |

### `video` – Current video

The newest video for the camera. Cloud is preferred automatically; falls back to local storage (Sync Module 2 USB stick) if needed.

| Datapoint | Type | Description |
|---|---|---|
| `video.file` | string | Absolute path of the MP4 (`<CamID>_latest.mp4`). |
| `video.timestamp` | string | Timestamp of the video content (ISO). |
| `video.id` | string | Unique clip ID from the Blink API. |
| `video.size` | number | File size in bytes. |
| `video.ready` | boolean | File was downloaded successfully and is playable. |
| `video.lastError` | string | Last download error. `""` = ok, otherwise message such as `no video available`. |

### `video.history.0` … `video.history.9` – Ring gallery

Each camera has **10 slots** containing the 10 most recent clips.
**Slot 0 = newest clip**, slot 9 = oldest. On each new clip the slots rotate automatically (oldest drops out).

| Datapoint | Type | Description |
|---|---|---|
| `video.history.<N>.file` | string | Absolute path of the MP4 (`<CamID>_history_<N>.mp4`). Constant filename per slot ⇒ stable URLs in VIS. |
| `video.history.<N>.id` | string | Unique clip ID from the Blink API. |
| `video.history.<N>.timestamp` | string | Timestamp of the clip content (ISO). |
| `video.history.<N>.source` | string | Source of the clip: `cloud` or `local_storage`. Empty if slot unused. |

### `commands` – Trigger datapoints

Set to `true` → action is executed, adapter automatically resets to `false`.

| Datapoint | Type | Action |
|---|---|---|
| `commands.snapshot` | boolean | Request a new snapshot (stored as Base64 state). |
| `commands.snapshot_file` | boolean | Additionally save the snapshot to a file. |
| `commands.fetch_video` | boolean | Download the latest video. Smart logic: cloud first, then local-storage fallback. |
| `commands.live_request` | boolean | Open live stream (TTL ~30 s). |
| `commands.motion_detect` | boolean | Toggle motion detection on the camera. |
| `commands.clear_session` | boolean | Clear the auth session (in case of login problems). |

---

## Sync module / network

Each sync module gets its own channel `blink.0.sync.<NetID>`. **Note:** The state path uses the `network_id`, not the actual sync-module device ID.

### `info` – Master data

| Datapoint | Type | Description |
|---|---|---|
| `info.name` | string | Network name (e.g. "Home"). |
| `info.serial` | string | Sync module serial number. |

### `status` – State

| Datapoint | Type | Description |
|---|---|---|
| `status.armed` | boolean | Network armed (enables motion detection on all cameras). |
| `status.last_update` | string | Timestamp of the last refresh (ISO). |

### `commands` – Trigger

| Datapoint | Type | Action |
|---|---|---|
| `commands.armed` | boolean | Sets the entire network armed (`true`) or disarmed (`false`). Affects all cameras in this network. |

---

## File layout in the snapshot directory

Default path: `/opt/iobroker/iobroker-data/blink/`

| File | Description |
|---|---|
| `<CamID>_latest.mp4` | Most recent video of the camera (see `video.file`). |
| `<CamID>_history_<N>.mp4` | History slot `N` of the camera (`video.history.<N>.file`). |
| `<CamID>_snapshot.jpg` | Last snapshot, if saved via `commands.snapshot_file`. |

Filenames are **constant per slot**, contents change on rotation. For web embedding use a cache-buster in the query string (`?t={timestamp}`) so the browser actually reloads the new file.

---

## Tips for VIS integration

For a **live preview** in VIS:
```
{cameras.1754227.video.file}      → absolute path
{cameras.1754227.video.timestamp} → use for cache-busting
{cameras.1754227.video.ready}     → if false, show a "no video" hint
{cameras.1754227.video.lastError} → if non-empty, show as error status
```

For the **history gallery** query slots 0–9 individually:
```
{cameras.1754227.video.history.0.file}
{cameras.1754227.video.history.0.timestamp}
{cameras.1754227.video.history.0.source}
... through slot 9
```

`source = "cloud"` means the clip came directly from the Blink cloud (fast, no stick upload).
`source = "local_storage"` means the clip was uploaded from the Sync Module 2 USB stick through the cloud.

## Notes

- Battery-powered warnings are handled via the `battery.*` states.
- Devices without a built-in battery, such as Mini/Owl/PanTilt-like devices, are excluded from battery warnings.
- In that case, `battery.lastMessage` is set to `no built in battery`.
- Live image states are updated when a snapshot is fetched or when live snapshots are enabled.
- MJPEG stream states are only relevant if streaming is enabled in the adapter configuration.
- Smart Detection states are updated when classified motion metadata is available from Blink Cloud.
  
## DISCLAIMER

All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries! This personal project is maintained in spare time and has no business goal. Blink is a trademark of Amazon Technologies, Inc..

## Changelog

Older entries are available in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.0.16 (2026-06-13)
* (Pischleuder) fix: chaged roles and hierachy

### 0.0.15 (2026-06-13)
* (Pischleuder1) LiveView: Camera model recognition (XT/XT2 without LiveView)
* correct entry point for cameras
* fix: several cameras showing the same video

### 0.0.14 (2026-05-29)
* fixed some sync module busy errors

### 0.0.13 (2026-05-28)
* If video.history.* states still contain clip IDs but the corresponding MP4 files are missing, the history is no longer considered current.
* Missing or zero-byte history files are redownloaded during the next sync
* Reuse of old slots now occurs only if the old MP4 file actually exists and is larger than 0 bytes

### 0.0.12 (2026-05-28)
* USB/Local Storage manifest is checked first
* Cloud storage is now used only as a fallback
* More robust Local Storage matching: camera_id / cameraId / device_id / deviceId, if present in the manifest otherwise, camera names (trimmed and lowercased)

## License

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