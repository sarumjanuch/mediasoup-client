import * as sdpTransform from 'sdp-transform';
import { Logger } from '../Logger';
import { UnsupportedError, InvalidStateError } from '../errors';
import * as utils from '../utils';
import * as ortc from '../ortc';
import * as sdpCommonUtils from './sdp/commonUtils';
import * as sdpUnifiedPlanUtils from './sdp/unifiedPlanUtils';
import {
	HandlerFactory,
	HandlerInterface,
	HandlerRunOptions,
	HandlerSendOptions,
	HandlerSendResult,
	HandlerReceiveOptions,
	HandlerReceiveResult,
	HandlerSendDataChannelOptions,
	HandlerSendDataChannelResult,
	HandlerReceiveDataChannelOptions,
	HandlerReceiveDataChannelResult,
} from './HandlerInterface';
import { RemoteSdp } from './sdp/RemoteSdp';
import { parse as parseScalabilityMode } from '../scalabilityModes';
import { IceParameters, DtlsRole } from '../Transport';
import {
	RtpCapabilities,
	RtpParameters,
	RtpEncodingParameters,
} from '../RtpParameters';
import { SctpCapabilities, SctpStreamParameters } from '../SctpParameters';

const logger = new Logger('Firefox120');

const SCTP_NUM_STREAMS = { OS: 16, MIS: 2048 };

export class Firefox120 extends HandlerInterface {
	// Closed flag.
	private _closed = false;
	// Handler direction.
	private _direction?: 'send' | 'recv';
	// Remote SDP handler.
	private _remoteSdp?: RemoteSdp;
	// Generic sending RTP parameters for audio and video.
	private _sendingRtpParametersByKind?: { [key: string]: RtpParameters };
	// Generic sending RTP parameters for audio and video suitable for the SDP
	// remote answer.
	private _sendingRemoteRtpParametersByKind?: { [key: string]: RtpParameters };
	// RTCPeerConnection instance.
	private _pc: any;
	// Map of RTCTransceivers indexed by MID.
	private readonly _mapMidTransceiver: Map<string, RTCRtpTransceiver> =
		new Map();
	// Local stream for sending.
	private readonly _sendStream = new MediaStream();
	// Whether a DataChannel m=application section has been created.
	private _hasDataChannelMediaSection = false;
	// Sending DataChannel id value counter. Incremented for each new DataChannel.
	private _nextSendSctpStreamId = 0;
	// Got transport local and remote parameters.
	private _transportReady = false;

	/**
	 * Creates a factory function.
	 */
	static createFactory(): HandlerFactory {
		return (): Firefox120 => new Firefox120();
	}

	constructor() {
		super();
	}

	get name(): string {
		return 'Firefox120';
	}

	close(): void {
		logger.debug('close()');

		if (this._closed) {
			return;
		}

		this._closed = true;

		// Close RTCPeerConnection.
		if (this._pc) {
			try {
				this._pc.close();
			} catch (error) {}
		}

		this.emit('@close');
	}

	async getNativeRtpCapabilities(): Promise<RtpCapabilities> {
		logger.debug('getNativeRtpCapabilities()');

		const pc = new (RTCPeerConnection as any)({
			iceServers: [],
			iceTransportPolicy: 'all',
			bundlePolicy: 'max-bundle',
			rtcpMuxPolicy: 'require',
		});

		// NOTE: We need to add a real video track to get the RID extension mapping,
		// otherwiser Firefox doesn't include it in the SDP.
		const canvas = document.createElement('canvas');

		// NOTE: Otherwise Firefox fails in next line.
		canvas.getContext('2d');

		const fakeStream = (canvas as any).captureStream();
		const fakeVideoTrack = fakeStream.getVideoTracks()[0];

		try {
			pc.addTransceiver('audio', { direction: 'sendrecv' });

			pc.addTransceiver(fakeVideoTrack, {
				direction: 'sendrecv',
				sendEncodings: [
					{ rid: 'r0', maxBitrate: 100000 },
					{ rid: 'r1', maxBitrate: 500000 },
				],
			});

			const offer = await pc.createOffer();

			try {
				canvas.remove();
			} catch (error) {}

			try {
				fakeVideoTrack.stop();
			} catch (error) {}

			try {
				pc.close();
			} catch (error) {}

			const sdpObject = sdpTransform.parse(offer.sdp);
			const nativeRtpCapabilities = sdpCommonUtils.extractRtpCapabilities({
				sdpObject,
			});

			return nativeRtpCapabilities;
		} catch (error) {
			try {
				canvas.remove();
			} catch (error2) {}

			try {
				fakeVideoTrack.stop();
			} catch (error2) {}

			try {
				pc.close();
			} catch (error2) {}

			throw error;
		}
	}

	async getNativeSctpCapabilities(): Promise<SctpCapabilities> {
		logger.debug('getNativeSctpCapabilities()');

		return {
			numStreams: SCTP_NUM_STREAMS,
		};
	}

	run({
		direction,
		iceParameters,
		iceCandidates,
		dtlsParameters,
		sctpParameters,
		iceServers,
		iceTransportPolicy,
		additionalSettings,
		proprietaryConstraints,
		extendedRtpCapabilities,
	}: HandlerRunOptions): void {
		this.assertNotClosed();

		logger.debug('run()');

		this._direction = direction;

		this._remoteSdp = new RemoteSdp({
			iceParameters,
			iceCandidates,
			dtlsParameters,
			sctpParameters,
		});

		this._sendingRtpParametersByKind = {
			audio: ortc.getSendingRtpParameters('audio', extendedRtpCapabilities),
			video: ortc.getSendingRtpParameters('video', extendedRtpCapabilities),
		};

		this._sendingRemoteRtpParametersByKind = {
			audio: ortc.getSendingRemoteRtpParameters(
				'audio',
				extendedRtpCapabilities
			),
			video: ortc.getSendingRemoteRtpParameters(
				'video',
				extendedRtpCapabilities
			),
		};

		this._pc = new (RTCPeerConnection as any)(
			{
				iceServers: iceServers || [],
				iceTransportPolicy: iceTransportPolicy || 'all',
				bundlePolicy: 'max-bundle',
				rtcpMuxPolicy: 'require',
				...additionalSettings,
			},
			proprietaryConstraints
		);

		this._pc.addEventListener('icegatheringstatechange', () => {
			this.emit('@icegatheringstatechange', this._pc.iceGatheringState);
		});

		if (this._pc.connectionState) {
			this._pc.addEventListener('connectionstatechange', () => {
				this.emit('@connectionstatechange', this._pc.connectionState);
			});
		} else {
			this._pc.addEventListener('iceconnectionstatechange', () => {
				logger.warn(
					'run() | pc.connectionState not supported, using pc.iceConnectionState'
				);

				switch (this._pc.iceConnectionState) {
					case 'checking': {
						this.emit('@connectionstatechange', 'connecting');

						break;
					}

					case 'connected':
					case 'completed': {
						this.emit('@connectionstatechange', 'connected');

						break;
					}

					case 'failed': {
						this.emit('@connectionstatechange', 'failed');

						break;
					}

					case 'disconnected': {
						this.emit('@connectionstatechange', 'disconnected');

						break;
					}

					case 'closed': {
						this.emit('@connectionstatechange', 'closed');

						break;
					}
				}
			});
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async updateIceServers(iceServers: RTCIceServer[]): Promise<void> {
		this.assertNotClosed();

		// NOTE: Firefox does not implement pc.setConfiguration().
		throw new UnsupportedError('not supported');
	}

	async restartIce(iceParameters: IceParameters): Promise<void> {
		this.assertNotClosed();

		logger.debug('restartIce()');

		// Provide the remote SDP handler with new remote ICE parameters.
		this._remoteSdp!.updateIceParameters(iceParameters);

		if (!this._transportReady) {
			return;
		}

		if (this._direction === 'send') {
			const offer = await this._pc.createOffer({ iceRestart: true });

			logger.debug(
				'restartIce() | calling pc.setLocalDescription() [offer:%o]',
				offer
			);

			await this._pc.setLocalDescription(offer);

			const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() };

			logger.debug(
				'restartIce() | calling pc.setRemoteDescription() [answer:%o]',
				answer
			);

			await this._pc.setRemoteDescription(answer);
		} else {
			const offer = { type: 'offer', sdp: this._remoteSdp!.getSdp() };

			logger.debug(
				'restartIce() | calling pc.setRemoteDescription() [offer:%o]',
				offer
			);

			await this._pc.setRemoteDescription(offer);

			const answer = await this._pc.createAnswer();

			logger.debug(
				'restartIce() | calling pc.setLocalDescription() [answer:%o]',
				answer
			);

			await this._pc.setLocalDescription(answer);
		}
	}

	async getTransportStats(): Promise<RTCStatsReport> {
		this.assertNotClosed();

		return this._pc.getStats();
	}

	async send({
		track,
		encodings,
		codecOptions,
		codec,
	}: HandlerSendOptions): Promise<HandlerSendResult> {
		this.assertNotClosed();
		this.assertSendDirection();

		logger.debug('send() [kind:%s, track.id:%s]', track.kind, track.id);

		if (encodings && encodings.length > 1) {
			encodings.forEach((encoding: RtpEncodingParameters, idx: number) => {
				encoding.rid = `r${idx}`;
			});
		}

		const sendingRtpParameters: RtpParameters = utils.clone<RtpParameters>(
			this._sendingRtpParametersByKind![track.kind]
		);

		// This may throw.
		sendingRtpParameters.codecs = ortc.reduceCodecs(
			sendingRtpParameters.codecs,
			codec
		);

		const sendingRemoteRtpParameters: RtpParameters =
			utils.clone<RtpParameters>(
				this._sendingRemoteRtpParametersByKind![track.kind]
			);

		// This may throw.
		sendingRemoteRtpParameters.codecs = ortc.reduceCodecs(
			sendingRemoteRtpParameters.codecs,
			codec
		);

		// NOTE: Firefox fails sometimes to properly anticipate the closed media
		// section that it should use, so don't reuse closed media sections.
		//   https://github.com/versatica/mediasoup-client/issues/104
		//
		// const mediaSectionIdx = this._remoteSdp!.getNextMediaSectionIdx();

		const transceiver = this._pc.addTransceiver(track, {
			direction: 'sendonly',
			streams: [this._sendStream],
			sendEncodings: encodings,
		});
		const offer = await this._pc.createOffer();
		let localSdpObject = sdpTransform.parse(offer.sdp);

		// In Firefox use DTLS role client even if we are the "offerer" since
		// Firefox does not respect ICE-Lite.
		if (!this._transportReady) {
			await this.setupTransport({ localDtlsRole: 'client', localSdpObject });
		}

		const layers = parseScalabilityMode((encodings || [{}])[0].scalabilityMode);

		logger.debug('send() | calling pc.setLocalDescription() [offer:%o]', offer);

		await this._pc.setLocalDescription(offer);

		// We can now get the transceiver.mid.
		const localId = transceiver.mid;

		// Set MID.
		sendingRtpParameters.mid = localId;

		localSdpObject = sdpTransform.parse(this._pc.localDescription.sdp);

		const offerMediaObject =
			localSdpObject.media[localSdpObject.media.length - 1];

		// Set RTCP CNAME.
		sendingRtpParameters.rtcp!.cname = sdpCommonUtils.getCname({
			offerMediaObject,
		});

		// Set RTP encodings by parsing the SDP offer if no encodings are given.
		if (!encodings) {
			sendingRtpParameters.encodings = sdpUnifiedPlanUtils.getRtpEncodings({
				offerMediaObject,
			});
		}
		// Set RTP encodings by parsing the SDP offer and complete them with given
		// one if just a single encoding has been given.
		else if (encodings.length === 1) {
			const newEncodings = sdpUnifiedPlanUtils.getRtpEncodings({
				offerMediaObject,
			});

			Object.assign(newEncodings[0], encodings[0]);

			sendingRtpParameters.encodings = newEncodings;
		}
		// Otherwise if more than 1 encoding are given use them verbatim.
		else {
			sendingRtpParameters.encodings = encodings;
		}

		// If VP8 or H264 and there is effective simulcast, add scalabilityMode to
		// each encoding.
		if (
			sendingRtpParameters.encodings.length > 1 &&
			(sendingRtpParameters.codecs[0].mimeType.toLowerCase() === 'video/vp8' ||
				sendingRtpParameters.codecs[0].mimeType.toLowerCase() === 'video/h264')
		) {
			for (const encoding of sendingRtpParameters.encodings) {
				if (encoding.scalabilityMode) {
					encoding.scalabilityMode = `L1T${layers.temporalLayers}`;
				} else {
					encoding.scalabilityMode = 'L1T3';
				}
			}
		}

		this._remoteSdp!.send({
			offerMediaObject,
			offerRtpParameters: sendingRtpParameters,
			answerRtpParameters: sendingRemoteRtpParameters,
			codecOptions,
			extmapAllowMixed: true,
		});

		const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'send() | calling pc.setRemoteDescription() [answer:%o]',
			answer
		);

		await this._pc.setRemoteDescription(answer);

		// Store in the map.
		this._mapMidTransceiver.set(localId, transceiver);

		return {
			localId,
			rtpParameters: sendingRtpParameters,
			rtpSender: transceiver.sender,
		};
	}

	async stopSending(localId: string): Promise<void> {
		this.assertSendDirection();

		logger.debug('stopSending() [localId:%s]', localId);

		if (this._closed) {
			return;
		}

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated transceiver not found');
		}

		transceiver.sender.replaceTrack(null);

		// NOTE: Cannot use stop() the transceiver due to the the note above in
		// send() method.
		// try
		// {
		// 	transceiver.stop();
		// }
		// catch (error)
		// {}

		this._pc.removeTrack(transceiver.sender);
		// NOTE: Cannot use closeMediaSection() due to the the note above in send()
		// method.
		// this._remoteSdp!.closeMediaSection(transceiver.mid);
		this._remoteSdp!.disableMediaSection(transceiver.mid!);

		const offer = await this._pc.createOffer();

		logger.debug(
			'stopSending() | calling pc.setLocalDescription() [offer:%o]',
			offer
		);

		await this._pc.setLocalDescription(offer);

		const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'stopSending() | calling pc.setRemoteDescription() [answer:%o]',
			answer
		);

		await this._pc.setRemoteDescription(answer);

		this._mapMidTransceiver.delete(localId);
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async pauseSending(localId: string): Promise<void> {
		this.assertNotClosed();
		this.assertSendDirection();

		logger.debug('pauseSending() [localId:%s]', localId);

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		transceiver.direction = 'inactive';
		this._remoteSdp!.pauseMediaSection(localId);

		const offer = await this._pc.createOffer();

		logger.debug(
			'pauseSending() | calling pc.setLocalDescription() [offer:%o]',
			offer
		);

		await this._pc.setLocalDescription(offer);

		const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'pauseSending() | calling pc.setRemoteDescription() [answer:%o]',
			answer
		);

		await this._pc.setRemoteDescription(answer);
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async resumeSending(localId: string): Promise<void> {
		this.assertNotClosed();
		this.assertSendDirection();

		logger.debug('resumeSending() [localId:%s]', localId);

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		transceiver.direction = 'sendonly';
		this._remoteSdp!.resumeSendingMediaSection(localId);

		const offer = await this._pc.createOffer();

		logger.debug(
			'resumeSending() | calling pc.setLocalDescription() [offer:%o]',
			offer
		);

		await this._pc.setLocalDescription(offer);

		const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'resumeSending() | calling pc.setRemoteDescription() [answer:%o]',
			answer
		);

		await this._pc.setRemoteDescription(answer);
	}

	async replaceTrack(
		localId: string,
		track: MediaStreamTrack | null
	): Promise<void> {
		this.assertNotClosed();
		this.assertSendDirection();

		if (track) {
			logger.debug(
				'replaceTrack() [localId:%s, track.id:%s]',
				localId,
				track.id
			);
		} else {
			logger.debug('replaceTrack() [localId:%s, no track]', localId);
		}

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		await transceiver.sender.replaceTrack(track);
	}

	async setMaxSpatialLayer(
		localId: string,
		spatialLayer: number
	): Promise<void> {
		this.assertNotClosed();
		this.assertSendDirection();

		logger.debug(
			'setMaxSpatialLayer() [localId:%s, spatialLayer:%s]',
			localId,
			spatialLayer
		);

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated transceiver not found');
		}

		const parameters = transceiver.sender.getParameters();

		parameters.encodings.forEach(
			(encoding: RTCRtpEncodingParameters, idx: number) => {
				if (idx <= spatialLayer) {
					encoding.active = true;
				} else {
					encoding.active = false;
				}
			}
		);

		await transceiver.sender.setParameters(parameters);

		this._remoteSdp!.muxMediaSectionSimulcast(localId, parameters.encodings);

		const offer = await this._pc.createOffer();

		logger.debug(
			'setMaxSpatialLayer() | calling pc.setLocalDescription() [offer:%o]',
			offer
		);

		await this._pc.setLocalDescription(offer);

		const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'setMaxSpatialLayer() | calling pc.setRemoteDescription() [answer:%o]',
			answer
		);

		await this._pc.setRemoteDescription(answer);
	}

	async setRtpEncodingParameters(localId: string, params: any): Promise<void> {
		this.assertNotClosed();
		this.assertSendDirection();

		logger.debug(
			'setRtpEncodingParameters() [localId:%s, params:%o]',
			localId,
			params
		);

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		const parameters = transceiver.sender.getParameters();

		parameters.encodings.forEach(
			(encoding: RTCRtpEncodingParameters, idx: number) => {
				parameters.encodings[idx] = { ...encoding, ...params };
			}
		);

		await transceiver.sender.setParameters(parameters);

		this._remoteSdp!.muxMediaSectionSimulcast(localId, parameters.encodings);

		const offer = await this._pc.createOffer();

		logger.debug(
			'setRtpEncodingParameters() | calling pc.setLocalDescription() [offer:%o]',
			offer
		);

		await this._pc.setLocalDescription(offer);

		const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'setRtpEncodingParameters() | calling pc.setRemoteDescription() [answer:%o]',
			answer
		);

		await this._pc.setRemoteDescription(answer);
	}

	async getSenderStats(localId: string): Promise<RTCStatsReport> {
		this.assertNotClosed();
		this.assertSendDirection();

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		return transceiver.sender.getStats();
	}

	async sendDataChannel({
		ordered,
		maxPacketLifeTime,
		maxRetransmits,
		label,
		protocol,
	}: HandlerSendDataChannelOptions): Promise<HandlerSendDataChannelResult> {
		this.assertNotClosed();
		this.assertSendDirection();

		const options = {
			negotiated: true,
			id: this._nextSendSctpStreamId,
			ordered,
			maxPacketLifeTime,
			maxRetransmits,
			protocol,
		};

		logger.debug('sendDataChannel() [options:%o]', options);

		const dataChannel = this._pc.createDataChannel(label, options);

		// Increase next id.
		this._nextSendSctpStreamId =
			++this._nextSendSctpStreamId % SCTP_NUM_STREAMS.MIS;

		// If this is the first DataChannel we need to create the SDP answer with
		// m=application section.
		if (!this._hasDataChannelMediaSection) {
			const offer = await this._pc.createOffer();
			const localSdpObject = sdpTransform.parse(offer.sdp);
			const offerMediaObject = localSdpObject.media.find(
				(m: any) => m.type === 'application'
			);

			if (!this._transportReady) {
				await this.setupTransport({ localDtlsRole: 'client', localSdpObject });
			}

			logger.debug(
				'sendDataChannel() | calling pc.setLocalDescription() [offer:%o]',
				offer
			);

			await this._pc.setLocalDescription(offer);

			this._remoteSdp!.sendSctpAssociation({ offerMediaObject });

			const answer = { type: 'answer', sdp: this._remoteSdp!.getSdp() };

			logger.debug(
				'sendDataChannel() | calling pc.setRemoteDescription() [answer:%o]',
				answer
			);

			await this._pc.setRemoteDescription(answer);

			this._hasDataChannelMediaSection = true;
		}

		const sctpStreamParameters: SctpStreamParameters = {
			streamId: options.id,
			ordered: options.ordered,
			maxPacketLifeTime: options.maxPacketLifeTime,
			maxRetransmits: options.maxRetransmits,
		};

		return { dataChannel, sctpStreamParameters };
	}

	async receive(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		optionsList: HandlerReceiveOptions[]
	): Promise<HandlerReceiveResult[]> {
		this.assertNotClosed();
		this.assertRecvDirection();

		const results: HandlerReceiveResult[] = [];
		const mapLocalId: Map<string, string> = new Map();

		for (const options of optionsList) {
			const { trackId, kind, rtpParameters, streamId } = options;

			logger.debug('receive() [trackId:%s, kind:%s]', trackId, kind);

			const localId = rtpParameters.mid || String(this._mapMidTransceiver.size);

			mapLocalId.set(trackId, localId);

			this._remoteSdp!.receive({
				mid: localId,
				kind,
				offerRtpParameters: rtpParameters,
				streamId: streamId || rtpParameters.rtcp!.cname!,
				trackId,
			});
		}

		const offer = { type: 'offer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'receive() | calling pc.setRemoteDescription() [offer:%o]',
			offer
		);

		await this._pc.setRemoteDescription(offer);

		let answer = await this._pc.createAnswer();
		const localSdpObject = sdpTransform.parse(answer.sdp);

		for (const options of optionsList) {
			const { trackId, rtpParameters } = options;
			const localId = mapLocalId.get(trackId);
			const answerMediaObject = localSdpObject.media.find(
				(m: any) => String(m.mid) === localId
			);

			// May need to modify codec parameters in the answer based on codec
			// parameters in the offer.
			sdpCommonUtils.applyCodecParameters({
				offerRtpParameters: rtpParameters,
				answerMediaObject,
			});

			answer = { type: 'answer', sdp: sdpTransform.write(localSdpObject) };
		}

		if (!this._transportReady) {
			await this.setupTransport({ localDtlsRole: 'client', localSdpObject });
		}

		logger.debug(
			'receive() | calling pc.setLocalDescription() [answer:%o]',
			answer
		);

		await this._pc.setLocalDescription(answer);

		for (const options of optionsList) {
			const { trackId } = options;
			const localId = mapLocalId.get(trackId)!;
			const transceiver = this._pc
				.getTransceivers()
				.find((t: RTCRtpTransceiver) => t.mid === localId);

			if (!transceiver) {
				throw new Error('new RTCRtpTransceiver not found');
			}

			// Store in the map.
			this._mapMidTransceiver.set(localId, transceiver);

			results.push({
				localId,
				track: transceiver.receiver.track,
				rtpReceiver: transceiver.receiver,
			});
		}

		return results;
	}

	async stopReceiving(localIds: string[]): Promise<void> {
		this.assertRecvDirection();

		if (this._closed) {
			return;
		}

		for (const localId of localIds) {
			logger.debug('stopReceiving() [localId:%s]', localId);

			const transceiver = this._mapMidTransceiver.get(localId);

			if (!transceiver) {
				throw new Error('associated RTCRtpTransceiver not found');
			}

			this._remoteSdp!.closeMediaSection(transceiver.mid!);
		}

		const offer = { type: 'offer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'stopReceiving() | calling pc.setRemoteDescription() [offer:%o]',
			offer
		);

		await this._pc.setRemoteDescription(offer);

		const answer = await this._pc.createAnswer();

		logger.debug(
			'stopReceiving() | calling pc.setLocalDescription() [answer:%o]',
			answer
		);

		await this._pc.setLocalDescription(answer);

		for (const localId of localIds) {
			this._mapMidTransceiver.delete(localId);
		}
	}

	async pauseReceiving(localIds: string[]): Promise<void> {
		this.assertNotClosed();
		this.assertRecvDirection();

		for (const localId of localIds) {
			logger.debug('pauseReceiving() [localId:%s]', localId);

			const transceiver = this._mapMidTransceiver.get(localId);

			if (!transceiver) {
				throw new Error('associated RTCRtpTransceiver not found');
			}

			transceiver.direction = 'inactive';
			this._remoteSdp!.pauseMediaSection(localId);
		}

		const offer = { type: 'offer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'pauseReceiving() | calling pc.setRemoteDescription() [offer:%o]',
			offer
		);

		await this._pc.setRemoteDescription(offer);

		const answer = await this._pc.createAnswer();

		logger.debug(
			'pauseReceiving() | calling pc.setLocalDescription() [answer:%o]',
			answer
		);

		await this._pc.setLocalDescription(answer);
	}

	async resumeReceiving(localIds: string[]): Promise<void> {
		this.assertNotClosed();
		this.assertRecvDirection();

		for (const localId of localIds) {
			logger.debug('resumeReceiving() [localId:%s]', localId);

			const transceiver = this._mapMidTransceiver.get(localId);

			if (!transceiver) {
				throw new Error('associated RTCRtpTransceiver not found');
			}

			transceiver.direction = 'recvonly';
			this._remoteSdp!.resumeReceivingMediaSection(localId);
		}

		const offer = { type: 'offer', sdp: this._remoteSdp!.getSdp() };

		logger.debug(
			'resumeReceiving() | calling pc.setRemoteDescription() [offer:%o]',
			offer
		);

		await this._pc.setRemoteDescription(offer);

		const answer = await this._pc.createAnswer();

		logger.debug(
			'resumeReceiving() | calling pc.setLocalDescription() [answer:%o]',
			answer
		);

		await this._pc.setLocalDescription(answer);
	}

	async getReceiverStats(localId: string): Promise<RTCStatsReport> {
		this.assertRecvDirection();

		const transceiver = this._mapMidTransceiver.get(localId);

		if (!transceiver) {
			throw new Error('associated RTCRtpTransceiver not found');
		}

		return transceiver.receiver.getStats();
	}

	async receiveDataChannel({
		sctpStreamParameters,
		label,
		protocol,
	}: HandlerReceiveDataChannelOptions): Promise<HandlerReceiveDataChannelResult> {
		this.assertNotClosed();
		this.assertRecvDirection();

		const {
			streamId,
			ordered,
			maxPacketLifeTime,
			maxRetransmits,
		}: SctpStreamParameters = sctpStreamParameters;

		const options = {
			negotiated: true,
			id: streamId,
			ordered,
			maxPacketLifeTime,
			maxRetransmits,
			protocol,
		};

		logger.debug('receiveDataChannel() [options:%o]', options);

		const dataChannel = this._pc.createDataChannel(label, options);

		// If this is the first DataChannel we need to create the SDP offer with
		// m=application section.
		if (!this._hasDataChannelMediaSection) {
			this._remoteSdp!.receiveSctpAssociation();

			const offer = { type: 'offer', sdp: this._remoteSdp!.getSdp() };

			logger.debug(
				'receiveDataChannel() | calling pc.setRemoteDescription() [offer:%o]',
				offer
			);

			await this._pc.setRemoteDescription(offer);

			const answer = await this._pc.createAnswer();

			if (!this._transportReady) {
				const localSdpObject = sdpTransform.parse(answer.sdp);

				await this.setupTransport({ localDtlsRole: 'client', localSdpObject });
			}

			logger.debug(
				'receiveDataChannel() | calling pc.setRemoteDescription() [answer:%o]',
				answer
			);

			await this._pc.setLocalDescription(answer);

			this._hasDataChannelMediaSection = true;
		}

		return { dataChannel };
	}

	private async setupTransport({
		localDtlsRole,
		localSdpObject,
	}: {
		localDtlsRole: DtlsRole;
		localSdpObject?: any;
	}): Promise<void> {
		if (!localSdpObject) {
			localSdpObject = sdpTransform.parse(this._pc.localDescription.sdp);
		}

		// Get our local DTLS parameters.
		const dtlsParameters = sdpCommonUtils.extractDtlsParameters({
			sdpObject: localSdpObject,
		});

		// Set our DTLS role.
		dtlsParameters.role = localDtlsRole;

		// Update the remote DTLS role in the SDP.
		this._remoteSdp!.updateDtlsRole(
			localDtlsRole === 'client' ? 'server' : 'client'
		);

		// Need to tell the remote transport about our parameters.
		await new Promise<void>((resolve, reject) => {
			this.safeEmit('@connect', { dtlsParameters }, resolve, reject);
		});

		this._transportReady = true;
	}

	private assertNotClosed(): void {
		if (this._closed) {
			throw new InvalidStateError('method called in a closed handler');
		}
	}

	private assertSendDirection(): void {
		if (this._direction !== 'send') {
			throw new Error(
				'method can just be called for handlers with "send" direction'
			);
		}
	}

	private assertRecvDirection(): void {
		if (this._direction !== 'recv') {
			throw new Error(
				'method can just be called for handlers with "recv" direction'
			);
		}
	}
}