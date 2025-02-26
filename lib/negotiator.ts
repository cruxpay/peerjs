import * as Reliable from "reliable";
import { util } from "./util";
import logger from "./logger";
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate
} from "./adapter";
import { MediaConnection } from "./mediaconnection";
import { DataConnection } from "./dataconnection";
import { ConnectionType, PeerErrorType, ConnectionEventType, ServerMessageType } from "./enums";
import { BaseConnection } from "./baseconnection";
import { Encryption } from "./encryption";

/**
 * Manages all negotiations between Peers.
 */
export class Negotiator {

  protected _encryption: typeof Encryption

  constructor(readonly connection: BaseConnection) {
  }

  /** Returns a PeerConnection object set up correctly (for data, media). */
  startConnection(options: any) {
    const peerConnection = this._startPeerConnection(); // create RPCPeerConnnection and setup listeners

    // Set the connection's PC.
    this.connection.peerConnection = peerConnection;
    if (this.connection.type === ConnectionType.Media && options._stream) {
      this._addTracksToConnection(options._stream, peerConnection);
    }
    if (options.originator) {
      if (this.connection.type === ConnectionType.Data) {
        const dataConnection = <DataConnection>this.connection;
        let config = {};
        if (!util.supports.sctp) {
          config = { reliable: options.reliable };
        }
        const dataChannel = peerConnection.createDataChannel(dataConnection.label, config);
        dataConnection.initialize(dataChannel);
      }
      this._makeOffer();
    } else {
      this.handleSDP("OFFER", options.sdp);
    }
  }

  private _startPeerConnection(): RTCPeerConnection {
    logger.log("Creating RTCPeerConnection.");

    let optional = {};

    if (this.connection.type === ConnectionType.Data && !util.supports.sctp) {
      optional = { optional: [{ RtpDataChannels: true }] };
    } else if (this.connection.type === ConnectionType.Media) {
      // Interop req for chrome.
      optional = { optional: [{ DtlsSrtpKeyAgreement: true }] };
    }
    const peerConnection = new RTCPeerConnection(this.connection.provider.options.config, optional);
    this._setupListeners(peerConnection);
    return peerConnection;
  }

  /** Set up various WebRTC listeners. */
  private _setupListeners(peerConnection: RTCPeerConnection) {
    const peerId = this.connection.peer;
    const connectionId = this.connection.connectionId;
    const connectionType = this.connection.type;
    const provider = this.connection.provider;

    // ICE CANDIDATES.
    logger.log("Listening for ICE candidates.");

    peerConnection.onicecandidate = (evt) => {
      if (evt.candidate) {
        logger.log("Received ICE candidates for:", peerId);
        provider.socket.send({
          type: ServerMessageType.Candidate,
          payload: {
            candidate: evt.candidate,
            type: connectionType,
            connectionId: connectionId
          },
          dst: peerId
        });
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      switch (peerConnection.iceConnectionState) {
        case "failed":
          logger.log(
            "iceConnectionState is failed, closing connections to " +
            peerId
          );
          this.connection.emit(
            ConnectionEventType.Error,
            new Error("Negotiation of connection to " + peerId + " failed.")
          );
          this.connection.close();
          break;
        case "closed":
          logger.log(
            "iceConnectionState is closed, closing connections to " +
            peerId
          );
          this.connection.emit(
            ConnectionEventType.Error,
            new Error("Negotiation of connection to " + peerId + " failed.")
          );
          this.connection.close();
          break;
        case "disconnected":
          logger.log(
            "iceConnectionState is disconnected, closing connections to " +
            peerId
          );
          break;
        case "completed":
          peerConnection.onicecandidate = util.noop;
          break;
      }

      this.connection.emit(ConnectionEventType.IceStateChanged, peerConnection.iceConnectionState);
    };

    // DATACONNECTION.
    logger.log("Listening for data channel");
    // Fired between offer and answer, so options should already be saved
    // in the options hash.
    peerConnection.ondatachannel = (evt) => {
      logger.log("Received data channel");

      const dataChannel = evt.channel;
      const connection = <DataConnection>(
        provider.getConnection(peerId, connectionId)
      );

      connection.initialize(dataChannel);
    };

    // MEDIACONNECTION.
    logger.log("Listening for remote stream");

    peerConnection.ontrack = (evt) => {
      logger.log("Received remote stream");

      const stream = evt.streams[0];
      const connection = provider.getConnection(peerId, connectionId);

      if (connection.type === ConnectionType.Media) {
        const mediaConnection = <MediaConnection>connection;

        this._addStreamToMediaConnection(stream, mediaConnection);
      }
    };
  }

  cleanup(): void {
    logger.log("Cleaning up PeerConnection to " + this.connection.peer);

    const peerConnection = this.connection.peerConnection;

    if (!peerConnection) {
      return;
    }

    this.connection.peerConnection = null;

    //unsubscribe from all PeerConnection's events
    peerConnection.onicecandidate = peerConnection.oniceconnectionstatechange = peerConnection.ondatachannel = peerConnection.ontrack = () => { };

    const peerConnectionNotClosed = peerConnection.signalingState !== "closed";
    let dataChannelNotClosed = false;

    if (this.connection.type === ConnectionType.Data) {
      const dataConnection = <DataConnection>this.connection;
      const dataChannel = dataConnection.dataChannel;

      if (dataChannel) {
        dataChannelNotClosed = !!dataChannel.readyState && dataChannel.readyState !== "closed";
      }
    }

    if (peerConnectionNotClosed || dataChannelNotClosed) {
      peerConnection.close();
    }
  }


  private async _makeOffer(): Promise<void> {
    const peerConnection = this.connection.peerConnection;
    const provider = this.connection.provider;

    try {
      const offer = await peerConnection.createOffer(this.connection.options.constraints);
      logger.log("Created offer.");
      if (!util.supports.sctp && this.connection.type === ConnectionType.Data) {
        const dataConnection = <DataConnection>this.connection;
        if (dataConnection.reliable) {
          offer.sdp = Reliable.higherBandwidthSDP(offer.sdp);
        }
      }
      if (this.connection.options.sdpTransform && typeof this.connection.options.sdpTransform === 'function') {
        offer.sdp = this.connection.options.sdpTransform(offer.sdp) || offer.sdp;
      }
      try {
        await peerConnection.setLocalDescription(offer);
        logger.log("Set localDescription:", offer, `for:${this.connection.peer}`);
        let payload: any = {
          sdp: offer,
          type: this.connection.type,
          connectionId: this.connection.connectionId,
          metadata: this.connection.metadata,
          browser: util.browser
        };
        // Encrypt the SDP using encryptionToken before pushing out the offer
        let encryptedSDP
        if (this.connection.type === ConnectionType.Data) {
          const dataConnection = <DataConnection>this.connection;
          payload = {...payload, label: dataConnection.label, reliable: dataConnection.reliable, serialization: dataConnection.serialization};
          if( !this.connection.options.encryptionPayload.encryptionToken || !this.connection.options.encryptionPayload.ephemeralPublicKey || !this.connection.options.encryptionPayload.ivHex ) throw (`Missing encryptionToken or ephemeralPublicKey or ivHex`)
          encryptedSDP = Encryption.encryptStringSymmetric(payload.sdp.sdp, this.connection.options.encryptionPayload.encryptionToken)
          payload.ephemeralPublicKey = this.connection.options.encryptionPayload.ephemeralPublicKey
          payload.ivHex = this.connection.options.encryptionPayload.ivHex
        }
        payload.sdp.sdp = encryptedSDP
        provider.socket.send({type: ServerMessageType.Offer, payload, dst: this.connection.peer});
      } catch (err) {
        // TODO: investigate why _makeOffer is being called from the answer
        if (err != "OperationError: Failed to set local offer sdp: Called in wrong state: kHaveRemoteOffer") {
          provider.emitError(PeerErrorType.WebRTC, err);
          logger.log("Failed to setLocalDescription, ", err);
        }
      }
    } catch (err_1) {
      provider.emitError(PeerErrorType.WebRTC, err_1);
      logger.log("Failed to createOffer, ", err_1);
    }
  }

  private async _makeAnswer(): Promise<void> {
    const peerConnection = this.connection.peerConnection;
    const provider = this.connection.provider;

    try {
      const answer = await peerConnection.createAnswer();
      logger.log("Created answer.");
      if (!util.supports.sctp && this.connection.type === ConnectionType.Data) {
        const dataConnection = <DataConnection>this.connection;
        if (dataConnection.reliable) {
          answer.sdp = Reliable.higherBandwidthSDP(answer.sdp);
        }
      }
      if (this.connection.options.sdpTransform && typeof this.connection.options.sdpTransform === 'function') {
        answer.sdp = this.connection.options.sdpTransform(answer.sdp) || answer.sdp;
      }
      try {
        await peerConnection.setLocalDescription(answer);
        logger.log(`Set localDescription:`, answer, `for:${this.connection.peer}`);
        let encryptedAnswer = answer.sdp;
        if(!this.connection.options.encryptionPayload.encryptionToken) throw (`Missing encryptionToken`)
        // Encrypt the Answer with encryptionToken before handing over to the initiator
        encryptedAnswer = Encryption.encryptStringSymmetric(answer.sdp, this.connection.options.encryptionPayload.encryptionToken)
        provider.socket.send({
          type: ServerMessageType.Answer,
          payload: {
            sdp: encryptedAnswer,
            type: this.connection.type,
            connectionId: this.connection.connectionId,
            browser: util.browser
          },
          dst: this.connection.peer
        });
      } catch (err) {
        provider.emitError(PeerErrorType.WebRTC, err);
        logger.log("Failed to setLocalDescription, ", err);
      }
    } catch (err_1) {
      provider.emitError(PeerErrorType.WebRTC, err_1);
      logger.log("Failed to create answer, ", err_1);
    }
  }

  /** Handle an SDP. */
  async handleSDP(type: string,sdp: any): Promise<void> {
    sdp = new RTCSessionDescription(sdp);
    const peerConnection = this.connection.peerConnection;
    const provider = this.connection.provider;
    logger.log("Setting remote description", sdp);
    const self = this;
    try {
      await peerConnection.setRemoteDescription(sdp);
      logger.log(`Set remoteDescription:${type} for:${this.connection.peer}`);
      if (type === "OFFER") {
        await self._makeAnswer();
      }
    } catch (err) {
      provider.emitError(PeerErrorType.WebRTC, err);
      logger.log("Failed to setRemoteDescription, ", err);
    }
  }

  /** Handle a candidate. */
  async handleCandidate(ice: any): Promise<void> {
    const candidate = ice.candidate;
    const sdpMLineIndex = ice.sdpMLineIndex;
    const sdpMid = ice.sdpMid;
    const peerConnection = this.connection.peerConnection;
    const provider = this.connection.provider;

    try {
      await peerConnection.addIceCandidate(
        new RTCIceCandidate({
          sdpMid: sdpMid,
          sdpMLineIndex: sdpMLineIndex,
          candidate: candidate
        })
      );
      logger.log(`Added ICE candidate for:${this.connection.peer}`);
    } catch (err) {
      provider.emitError(PeerErrorType.WebRTC, err);
      logger.log("Failed to handleCandidate, ", err);
    }
  }

  private _addTracksToConnection(
    stream: MediaStream,
    peerConnection: RTCPeerConnection
  ): void {
    logger.log(`add tracks from stream ${stream.id} to peer connection`);

    if (!peerConnection.addTrack) {
      return logger.error(
        `Your browser does't support RTCPeerConnection#addTrack. Ignored.`
      );
    }

    stream.getTracks().forEach(track => {
      peerConnection.addTrack(track, stream);
    });
  }

  private _addStreamToMediaConnection(
    stream: MediaStream,
    mediaConnection: MediaConnection
  ): void {
    logger.log(
      `add stream ${stream.id} to media connection ${
      mediaConnection.connectionId
      }`
    );

    mediaConnection.addStream(stream);
  }
}
