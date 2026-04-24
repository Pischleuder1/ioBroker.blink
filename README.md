![Logo](admin/blink.png)
# ioBroker.blink

[![NPM version](https://img.shields.io/npm/v/iobroker.blink.svg)](https://www.npmjs.com/package/iobroker.blink)
[![Downloads](https://img.shields.io/npm/dm/iobroker.blink.svg)](https://www.npmjs.com/package/iobroker.blink)
![Number of Installations](https://iobroker.live/badges/blink-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/blink-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.blink.png?downloads=true)](https://nodei.co/npm/iobroker.blink/)


## blink adapter for ioBroker

ioBroker adapter for Blink cameras

## Getting started

Install via the ioBroker Admin interface : https://github.com/Pischleuder1/ioBroker.blink

## Developer manual

This adapter sets and displays the status of Amazon's Blink cameras.

The following can be accessed via the corresponding states:

* The camera can be armed/disarmed
* Currently saved videos can be retrieved
* The current snapshot of each camera can be retrieved
* The temperature of each camera  
* The battery status 
* Low battery status can be sent via Pushover
* The status of the sync module 
* Corresponding image and video files are stored under /opt/iobroker/iobroker-data/blink
* The storage location can be set in the admin area
* Images can be written to a state in base64 format
* Automatic deletion after a time interval

|  cameras |   | Type  | Value | Explanation
| -
| battery |  LastMessage  |  text   |text message | message via pushover 
|  |LastWarning |  date| date message | date of last warning
|  |  low | state  | true / false  
|   | WarningSent  | state  | true / false  
| commands |  clearSession  |  state  | true / false   
|  |fetch_video|  state| true / false |  get last saved video
|  |  motion_detect | state  | true / false  | normally set by.app
|   | snapshot  | state  | true / false | take a current snapshot 
|   | snapshotfile  | state  | directory   | path where snapshot is saved
| info |  name  |  state  | text | camera name   
|  |network_id|  state| text | network id of camera 
|  |  serial | state  | text | serial number of camera  
| live |  file  |  state | text  | path and filename of the snapshot   
|  |image_base64|  state| text |  base64 encoded file
|  |  mimetype| state  | text  | image/jpeg
|   | timestamp  | state  | date | timestamp of the saved snapshot 
| status |  armed  |  state | true / false  | is camera armed or not
|  |battery|  state| value.battery |  battery charge level in volt
|  |  battery_raw| state  | value.battery | battery charge level in raw data
|   | motion_detect_enabled | state  | true / false | 
|   | temperature | value.temperature  | number | temperature in volts 
|   | temperature_f | value.temperature  | number | temperature in fahrenheit
| video |  file |  state | true / false  | is camera armed or not
|  |id|  state| value.battery |  battery charge level in volt
|  |  lastError| state  | text | if error occurs
|   | ready | state  | true / false | 
|   | size | state | value  | size of file
|   | timestamp | state  | date | timestamp of the saved videofile



|  info |  | Type | Value | Explanation |
| -
| connection | |  state  |  true / false | connection status to blink cloud

|  sync module id |   | Type  | Value | Explanation
| -
| commands |   armed   | state | true / false | arme manually 
|  info| name |  text | text | name of sync module
| |  serial | state  | text | serial nr. of sync module | 
|  status| armed |  state | true / false | status of sync module 
| |  last_update | state  | date | timestamp of status | 


## DISCLAIMER

All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries! This personal project is maintained in spare time and has no business goal. Blink is a trademark of Amazon Technologies, Inc..

## Changelog

### 0.0.2 (2026-04-24)
* update language
* Updated Blink API integration and package metadata.
  
### 0.0.1 (2026-04-23)
* initial release

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
