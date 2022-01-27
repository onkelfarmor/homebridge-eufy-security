"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamingDelegate = void 0;
const child_process_1 = require("child_process");
const dgram_1 = require("dgram");
const ffmpeg_for_homebridge_1 = __importDefault(require("ffmpeg-for-homebridge"));
const pick_port_1 = __importDefault(require("pick-port"));
const ffmpeg_1 = require("./ffmpeg");
const UniversalStream_1 = require("./UniversalStream");
const fs_1 = require("fs");
const util_1 = require("util");
const readFileAsync = (0, util_1.promisify)(fs_1.readFile), SnapshotUnavailablePath = require.resolve('../../media/Snapshot-Unavailable.png');
class StreamingDelegate {
    constructor(platform, device, cameraConfig, api, hap) {
        // keep track of sessions
        this.pendingSessions = new Map();
        this.ongoingSessions = new Map();
        this.timeouts = new Map();
        this.log = platform.log;
        this.hap = hap;
        this.platform = platform;
        this.device = device;
        this.cameraName = device.getName();
        this.unbridge = false;
        this.videoConfig = cameraConfig.videoConfig;
        this.videoProcessor = ffmpeg_for_homebridge_1.default || 'ffmpeg';
        api.on("shutdown" /* SHUTDOWN */, () => {
            for (const session in this.ongoingSessions) {
                this.stopStream(session);
            }
        });
        const options = {
            cameraStreamCount: this.videoConfig.maxStreams || 2,
            delegate: this,
            streamingOptions: {
                supportedCryptoSuites: [0 /* AES_CM_128_HMAC_SHA1_80 */],
                video: {
                    resolutions: [
                        [320, 180, 30],
                        [320, 240, 15],
                        [320, 240, 30],
                        [480, 270, 30],
                        [480, 360, 30],
                        [640, 360, 30],
                        [640, 480, 30],
                        [1280, 720, 30],
                        [1280, 960, 30],
                        [1920, 1080, 30],
                        [1600, 1200, 30]
                    ],
                    codec: {
                        profiles: [0 /* BASELINE */, 1 /* MAIN */, 2 /* HIGH */],
                        levels: [0 /* LEVEL3_1 */, 1 /* LEVEL3_2 */, 2 /* LEVEL4_0 */]
                    }
                },
                audio: {
                    twoWayAudio: !!this.videoConfig.returnAudioTarget,
                    codecs: [
                        {
                            type: "AAC-eld" /* AAC_ELD */,
                            samplerate: 16 /* KHZ_16 */
                            /*type: AudioStreamingCodecType.OPUS,
                            samplerate: AudioStreamingSamplerate.KHZ_24*/
                        }
                    ]
                }
            }
        };
        this.controller = new hap.CameraController(options);
    }
    determineResolution(request, isSnapshot) {
        var _a;
        const resInfo = {
            width: request.width,
            height: request.height
        };
        if (!isSnapshot) {
            if (this.videoConfig.maxWidth !== undefined &&
                (this.videoConfig.forceMax || request.width > this.videoConfig.maxWidth)) {
                resInfo.width = this.videoConfig.maxWidth;
            }
            if (this.videoConfig.maxHeight !== undefined &&
                (this.videoConfig.forceMax || request.height > this.videoConfig.maxHeight)) {
                resInfo.height = this.videoConfig.maxHeight;
            }
        }
        const filters = ((_a = this.videoConfig.videoFilter) === null || _a === void 0 ? void 0 : _a.split(',')) || [];
        const noneFilter = filters.indexOf('none');
        if (noneFilter >= 0) {
            filters.splice(noneFilter, 1);
        }
        resInfo.snapFilter = filters.join(',');
        if ((noneFilter < 0) && (resInfo.width > 0 || resInfo.height > 0)) {
            resInfo.resizeFilter = 'scale=' + (resInfo.width > 0 ? '\'min(' + resInfo.width + ',iw)\'' : 'iw') + ':' +
                (resInfo.height > 0 ? '\'min(' + resInfo.height + ',ih)\'' : 'ih') +
                ':force_original_aspect_ratio=decrease';
            filters.push(resInfo.resizeFilter);
            filters.push('scale=\'trunc(iw/2)*2:trunc(ih/2)*2\''); // Force to fit encoder restrictions
        }
        if (filters.length > 0) {
            resInfo.videoFilter = filters.join(',');
        }
        return resInfo;
    }
    fetchSnapshot(snapFilter) {
        return new Promise(async (resolve, reject) => {
            const streamData = await this.getLocalLiveStream();
            const startTime = Date.now();
            const ffmpegArgs = '-probesize 3000 -analyzeduration 0 -ss 00:00:00.500 -i pipe: -frames:v 1 -c:v copy' +
                (snapFilter ? ' -filter:v ' + snapFilter : '') +
                ' -f image2 -' +
                ' -hide_banner' +
                ' -loglevel +verbose';
            this.log.debug(this.cameraName, 'Snapshot command: ' + this.videoProcessor + ' ' + ffmpegArgs, this.videoConfig.debug);
            const ffmpeg = (0, child_process_1.spawn)(this.videoProcessor, ffmpegArgs.split(/\s+/), { env: process.env });
            streamData.videostream.pipe(ffmpeg.stdin);
            let snapshotBuffer = Buffer.alloc(0);
            ffmpeg.stdout.on('data', (data) => {
                snapshotBuffer = Buffer.concat([snapshotBuffer, data]);
            });
            ffmpeg.on('error', (error) => {
                reject('FFmpeg process creation failed: ' + error.message);
            });
            ffmpeg.stderr.on('data', (data) => {
                data.toString().split('\n').forEach((line) => {
                    if (this.videoConfig.debug && line.length > 0) { // For now only write anything out when debug is set
                        this.log.error(line, this.cameraName + '] [Snapshot');
                    }
                });
            });
            ffmpeg.on('close', () => {
                if (snapshotBuffer.length > 0) {
                    resolve(snapshotBuffer);
                }
                else {
                    reject('Failed to fetch snapshot.');
                }
                this.platform.eufyClient.stopStationLivestream(this.device.getSerial());
                setTimeout(() => {
                    this.log.warn('Setting snapshotPromise to undefined.');
                    this.snapshotPromise = undefined;
                }, 3 * 1000); // Expire cached snapshot after 3 seconds
                const runtime = (Date.now() - startTime) / 1000;
                let message = 'Fetching snapshot took ' + runtime + ' seconds.';
                if (runtime < 5) {
                    this.log.debug(message, this.cameraName, this.videoConfig.debug);
                }
                else {
                    if (!this.unbridge) {
                        message += ' It is highly recommended you switch to unbridge mode.';
                    }
                    if (runtime < 22) {
                        this.log.warn(message, this.cameraName);
                    }
                    else {
                        message += ' The request has timed out and the snapshot has not been refreshed in HomeKit.';
                        this.log.error(message, this.cameraName);
                    }
                }
            });
        });
    }
    resizeSnapshot(snapshot, resizeFilter) {
        return new Promise((resolve, reject) => {
            const ffmpegArgs = '-i pipe:' + // Resize
                ' -frames:v 1' +
                (resizeFilter ? ' -filter:v ' + resizeFilter : '') +
                ' -f image2 -';
            this.log.debug(this.cameraName, 'Resize command: ' + this.videoProcessor + ' ' + ffmpegArgs, this.videoConfig.debug);
            const ffmpeg = (0, child_process_1.spawn)(this.videoProcessor, ffmpegArgs.split(/\s+/), { env: process.env });
            let resizeBuffer = Buffer.alloc(0);
            ffmpeg.stdout.on('data', (data) => {
                resizeBuffer = Buffer.concat([resizeBuffer, data]);
            });
            ffmpeg.on('error', (error) => {
                reject('FFmpeg process creation failed: ' + error.message);
            });
            ffmpeg.on('close', () => {
                resolve(resizeBuffer);
            });
            ffmpeg.stdin.end(snapshot);
        });
    }
    async handleSnapshotRequest(request, callback) {
        this.log.error('handleSnapshotRequest');
        this.log.error('snapshotPromise: ' + !!this.snapshotPromise);
        const resolution = this.determineResolution(request, true);
        try {
            const cachedSnapshot = !!this.snapshotPromise;
            this.log.debug('Snapshot requested: ' + request.width + ' x ' + request.height, this.cameraName, this.videoConfig.debug);
            let snapshot;
            if (this.snapshotPromise) {
                this.log.error('Awaiting promise');
                snapshot = await this.snapshotPromise;
            }
            else {
                this.log.error('Calling fetchSnapshot');
                snapshot = await this.fetchSnapshot(resolution.snapFilter);
            }
            this.log.warn('snapshot byte lenght: ' + (snapshot === null || snapshot === void 0 ? void 0 : snapshot.byteLength));
            this.log.debug('Sending snapshot: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                (resolution.height > 0 ? resolution.height : 'native') +
                (cachedSnapshot ? ' (cached)' : ''), this.cameraName, this.videoConfig.debug);
            const resized = await this.resizeSnapshot(snapshot, resolution.resizeFilter);
            callback(undefined, resized);
        }
        catch (err) {
            this.log.error(this.cameraName, err);
            callback();
        }
    }
    async prepareStream(request, callback) {
        const ipv6 = request.addressVersion === 'ipv6';
        const options = {
            type: 'udp',
            ip: ipv6 ? '::' : '0.0.0.0',
            reserveTimeout: 15
        };
        const videoReturnPort = await (0, pick_port_1.default)(options);
        const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
        const audioReturnPort = await (0, pick_port_1.default)(options);
        const audioSSRC = this.hap.CameraController.generateSynchronisationSource();
        const sessionInfo = {
            address: request.targetAddress,
            ipv6: ipv6,
            videoPort: request.video.port,
            videoReturnPort: videoReturnPort,
            videoCryptoSuite: request.video.srtpCryptoSuite,
            videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
            videoSSRC: videoSSRC,
            audioPort: request.audio.port,
            audioReturnPort: audioReturnPort,
            audioCryptoSuite: request.audio.srtpCryptoSuite,
            audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
            audioSSRC: audioSSRC
        };
        const response = {
            video: {
                port: videoReturnPort,
                ssrc: videoSSRC,
                srtp_key: request.video.srtp_key,
                srtp_salt: request.video.srtp_salt
            },
            audio: {
                port: audioReturnPort,
                ssrc: audioSSRC,
                srtp_key: request.audio.srtp_key,
                srtp_salt: request.audio.srtp_salt
            }
        };
        this.pendingSessions.set(request.sessionID, sessionInfo);
        callback(undefined, response);
    }
    async getLocalLiveStream() {
        return new Promise((resolve, reject) => {
            const station = this.platform.getStationById(this.device.getStationSerial());
            const isLiveStreaming = station.isLiveStreaming(this.device);
            this.platform.eufyClient.startStationLivestream(this.device.getSerial());
            this.log.error('isLiveStreaming: ' + isLiveStreaming);
            if (isLiveStreaming) {
                if (this.stationStream !== undefined) {
                    resolve(this.stationStream);
                }
                reject('Station responded with isLiveStreaming but we had no stream.');
            }
            station.on('livestream start', (station, channel, metadata, videostream, audiostream) => {
                if (this.platform.eufyClient.getStationDevice(station.getSerial(), channel).getSerial() === this.device.getSerial()) {
                    const stationStream = { station, channel, metadata, videostream, audiostream };
                    this.stationStream = stationStream;
                    resolve(stationStream);
                }
            });
        });
    }
    async startStream(request, callback) {
        const streamData = await this.getLocalLiveStream();
        this.log.debug('ReqHK:', JSON.stringify(request));
        this.log.debug('ReqEufy:', JSON.stringify(streamData.metadata));
        const uVideoStream = (0, UniversalStream_1.StreamInput)(streamData.videostream, this.cameraName + '_video', this.log);
        const sessionInfo = this.pendingSessions.get(request.sessionID);
        if (sessionInfo) {
            const vcodec = this.videoConfig.vcodec || 'libx264';
            const mtu = this.videoConfig.packetSize || 1316; // request.video.mtu is not used
            let encoderOptions = this.videoConfig.encoderOptions;
            if (!encoderOptions && vcodec === 'libx264') {
                encoderOptions = '-preset ultrafast -tune zerolatency';
            }
            const resolution = this.determineResolution(request.video, false);
            let fps = (this.videoConfig.maxFPS !== undefined &&
                (this.videoConfig.forceMax || request.video.fps > this.videoConfig.maxFPS)) ?
                this.videoConfig.maxFPS : request.video.fps;
            let videoBitrate = (this.videoConfig.maxBitrate !== undefined &&
                (this.videoConfig.forceMax || request.video.max_bit_rate > this.videoConfig.maxBitrate)) ?
                this.videoConfig.maxBitrate : request.video.max_bit_rate;
            if (vcodec === 'copy') {
                resolution.width = 0;
                resolution.height = 0;
                resolution.videoFilter = undefined;
                fps = 0;
                videoBitrate = 0;
            }
            this.log.debug(this.cameraName, 'Video stream requested: ' + request.video.width + ' x ' + request.video.height + ', ' +
                request.video.fps + ' fps, ' + request.video.max_bit_rate + ' kbps', this.videoConfig.debug);
            this.log.info(this.cameraName, 'Starting video stream: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                (resolution.height > 0 ? resolution.height : 'native') + ', ' + (fps > 0 ? fps : 'native') +
                ' fps, ' + (videoBitrate > 0 ? videoBitrate : '???') + ' kbps' +
                (this.videoConfig.audio ? (' (' + request.audio.codec + ')') : ''));
            let ffmpegArgs_video = [''];
            ffmpegArgs_video.push('-use_wallclock_as_timestamps 1');
            ffmpegArgs_video.push((streamData.metadata.videoCodec === 0) ? '-f h264' : '');
            ffmpegArgs_video.push(`-r ${streamData.metadata.videoFPS}`);
            ffmpegArgs_video.push(`-i ${uVideoStream.url}`);
            ffmpegArgs_video.push(// Video
            (this.videoConfig.mapvideo ? '-map ' + this.videoConfig.mapvideo : '-an -sn -dn'), '-codec:v ' + vcodec, '-pix_fmt yuv420p', '-color_range mpeg', (fps > 0 ? '-r ' + fps : ''), (encoderOptions || ''), (resolution.videoFilter ? '-filter:v ' + resolution.videoFilter : ''), (videoBitrate > 0 ? '-b:v ' + videoBitrate + 'k' : ''), '-payload_type ' + request.video.pt);
            ffmpegArgs_video.push(// Video Stream
            '-ssrc ' + sessionInfo.videoSSRC, '-f rtp', '-srtp_out_suite AES_CM_128_HMAC_SHA1_80', '-srtp_out_params ' + sessionInfo.videoSRTP.toString('base64'), 'srtp://' + sessionInfo.address + ':' + sessionInfo.videoPort +
                '?rtcpport=' + sessionInfo.videoPort + '&pkt_size=' + mtu);
            ffmpegArgs_video.push('-loglevel level' + (this.videoConfig.debug ? '+verbose' : ''), '-progress pipe:1');
            const clean_ffmpegArgs_video = ffmpegArgs_video.filter(function (el) { return el; });
            const activeSession = {};
            activeSession.vsocket = (0, dgram_1.createSocket)(sessionInfo.ipv6 ? 'udp6' : 'udp4');
            activeSession.vsocket.on('error', (err) => {
                this.log.error(this.cameraName, 'Socket error: ' + err.message);
                // uVideoStream.close();
                this.stopStream(request.sessionID);
            });
            activeSession.vsocket.on('message', () => {
                if (activeSession.timeout) {
                    clearTimeout(activeSession.timeout);
                }
                activeSession.timeout = setTimeout(() => {
                    this.log.info(this.cameraName, 'Device appears to be inactive. Stopping stream.');
                    this.controller.forceStopStreamingSession(request.sessionID);
                    // uVideoStream.close();
                    this.stopStream(request.sessionID);
                }, request.video.rtcp_interval * 5 * 1000);
            });
            activeSession.vsocket.bind(sessionInfo.videoReturnPort);
            activeSession.uVideoStream = uVideoStream;
            activeSession.mainProcess_video = new ffmpeg_1.FfmpegProcess(this.cameraName + '_video', request.sessionID, this.videoProcessor, clean_ffmpegArgs_video, this.log, this.videoConfig.debug, this, callback);
            // Required audio came to early so end user will see a lag of the video
            await new Promise((resolve) => { setTimeout(resolve, 6000); });
            const uAudioStream = (0, UniversalStream_1.StreamInput)(streamData.audiostream, this.cameraName + '_audio', this.log);
            let ffmpegArgs_audio = [''];
            ffmpegArgs_audio.push(`-i ${uAudioStream.url}`);
            if (request.audio.codec === "OPUS" /* OPUS */ || request.audio.codec === "AAC-eld" /* AAC_ELD */) {
                ffmpegArgs_audio.push(// Audio
                (this.videoConfig.mapaudio ? '-map ' + this.videoConfig.mapaudio : '-vn -sn -dn'), (request.audio.codec === "OPUS" /* OPUS */ ?
                    '-codec:a libopus' + ' -application lowdelay' :
                    '-codec:a libfdk_aac' + ' -profile:a aac_eld'), '-flags +global_header', '-ar ' + request.audio.sample_rate + 'k', '-b:a ' + request.audio.max_bit_rate + 'k', '-ac ' + request.audio.channel, '-payload_type ' + request.audio.pt);
                ffmpegArgs_audio.push(// Audio Stream
                '-ssrc ' + sessionInfo.audioSSRC, '-f rtp', '-srtp_out_suite AES_CM_128_HMAC_SHA1_80', '-srtp_out_params ' + sessionInfo.audioSRTP.toString('base64'), 'srtp://' + sessionInfo.address + ':' + sessionInfo.audioPort +
                    '?rtcpport=' + sessionInfo.audioPort + '&pkt_size=188');
                ffmpegArgs_audio.push('-loglevel level' + (this.videoConfig.debug ? '+verbose' : ''), '-progress pipe:1');
                const clean_ffmpegArgs_audio = ffmpegArgs_audio.filter(function (el) { return el; });
                activeSession.asocket = (0, dgram_1.createSocket)(sessionInfo.ipv6 ? 'udp6' : 'udp4');
                activeSession.asocket.on('error', (err) => {
                    this.log.error(this.cameraName, 'Socket error: ' + err.message);
                    // uAudioStream.close();
                    this.stopStream(request.sessionID);
                });
                activeSession.asocket.on('message', () => {
                    if (activeSession.timeout) {
                        clearTimeout(activeSession.timeout);
                    }
                    activeSession.timeout = setTimeout(() => {
                        this.log.info(this.cameraName, 'Device appears to be inactive. Stopping stream.');
                        this.controller.forceStopStreamingSession(request.sessionID);
                        // uAudioStream.close();
                        this.stopStream(request.sessionID);
                    }, request.audio.rtcp_interval * 5 * 1000);
                });
                activeSession.asocket.bind(sessionInfo.audioReturnPort);
                activeSession.uAudioStream = uAudioStream;
                activeSession.mainProcess_audio = new ffmpeg_1.FfmpegProcess(this.cameraName + '_audio', request.sessionID, this.videoProcessor, clean_ffmpegArgs_audio, this.log, this.videoConfig.debug, this);
            }
            else {
                this.log.error(this.cameraName, 'Unsupported audio codec requested: ' + request.audio.codec);
            }
            streamData.station.on('livestream stop', (station, channel) => {
                if (this.platform.eufyClient.getStationDevice(station.getSerial(), channel).getSerial() === this.device.getSerial()) {
                    this.log.info(this.cameraName, 'Eufy Station stopped the stream. Stopping stream.');
                    this.controller.forceStopStreamingSession(request.sessionID);
                    // uVideoStream.close();
                    // uAudioStream.close();
                    this.stopStream(request.sessionID);
                }
            });
            // Check if the pendingSession has been stopped before it was successfully started.
            const pendingSession = this.pendingSessions.get(request.sessionID);
            // pendingSession has not been deleted. Transfer it to ongoingSessions.
            if (pendingSession) {
                this.ongoingSessions.set(request.sessionID, activeSession);
                this.pendingSessions.delete(request.sessionID);
            }
            // pendingSession has been deleted. Add it to ongoingSession and end it immediately.
            else {
                this.ongoingSessions.set(request.sessionID, activeSession);
                this.stopStream(request.sessionID);
            }
        }
        else {
            this.log.error(this.cameraName, 'Error finding session information.');
            callback(new Error('Error finding session information'));
        }
    }
    handleStreamRequest(request, callback) {
        switch (request.type) {
            case "start" /* START */:
                this.startStream(request, callback);
                break;
            case "reconfigure" /* RECONFIGURE */:
                this.log.debug(this.cameraName, 'Received request to reconfigure: ' + request.video.width + ' x ' + request.video.height + ', ' +
                    request.video.fps + ' fps, ' + request.video.max_bit_rate + ' kbps (Ignored)', this.videoConfig.debug);
                callback();
                break;
            case "stop" /* STOP */:
                this.stopStream(request.sessionID);
                callback();
                break;
        }
    }
    stopStream(sessionId) {
        var _a, _b, _c, _d, _e, _f;
        this.log.info('Stopping session with id: ' + sessionId);
        const pendingSession = this.pendingSessions.get(sessionId);
        if (pendingSession) {
            this.pendingSessions.delete(sessionId);
        }
        const session = this.ongoingSessions.get(sessionId);
        if (session) {
            if (session.timeout) {
                clearTimeout(session.timeout);
            }
            (_a = session.uVideoStream) === null || _a === void 0 ? void 0 : _a.close();
            (_b = session.uAudioStream) === null || _b === void 0 ? void 0 : _b.close();
            try {
                (_c = session.mainProcess_video) === null || _c === void 0 ? void 0 : _c.stop();
                (_d = session.mainProcess_audio) === null || _d === void 0 ? void 0 : _d.stop();
            }
            catch (err) {
                this.log.error(this.cameraName, 'Error occurred terminating main FFmpeg process: ' + err);
            }
            try {
                this.platform.eufyClient.stopStationLivestream(this.device.getSerial());
            }
            catch (err) {
                this.log.error(this.cameraName, 'Error occurred terminating Eufy Station livestream: ' + err);
            }
            try {
                (_e = session.vsocket) === null || _e === void 0 ? void 0 : _e.close();
                (_f = session.asocket) === null || _f === void 0 ? void 0 : _f.close();
            }
            catch (err) {
                this.log.error(this.cameraName, 'Error occurred closing socket: ' + err);
            }
            this.ongoingSessions.delete(sessionId);
            this.log.info(this.cameraName, 'Stopped video stream.');
        }
        else {
            this.log.info('No session to stop.');
        }
    }
}
exports.StreamingDelegate = StreamingDelegate;
//# sourceMappingURL=streamingDelegate.js.map
