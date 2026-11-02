/**
 * Rebuild-only UI messages.
 *
 * These are NOT part of the shipped message catalogue: the original panel renders directly from
 * `chrome.storage` change events, so it never needs a request/snapshot pair. The rebuild uses an
 * explicit snapshot to keep the panel decoupled from internal state shapes. Keeping these names
 * out of `MSG` preserves `test/messages.test.ts` as a parity proof of the original catalogue.
 */
import { Channel, type ChannelValue } from "./channels.js";

export const REBUILD_MESSAGES = {
  /** content → service (channel 1): ask for a `PanelSnapshot`. */
  RequestSession: "request_session",
  /** service → content (channel 6): serde-encoded `PanelSnapshot`. */
  SessionSnapshot: "session_snapshot",
  /** content → service (channel 1): the page reported which media is focused/playing. */
  MediaFocus: "media_focus",
} as const;

export interface RebuildEnvelope {
  msg: { name: string; data: unknown };
  channel: ChannelValue;
}

/**
 * A panel asks for a snapshot on load and then polls to recover pushes lost while the service
 * worker was asleep. `instance` is a nonce that is fresh for every panel page load: it tells the
 * service that this panel has not received its snapshot yet, so it must be answered even when the
 * content did not change. A poll without a nonce is answered as well.
 */
export interface RequestSessionData {
  instance?: string;
}

export function makeRequestSessionEnvelope(instance?: string): RebuildEnvelope {
  return {
    msg: {
      name: REBUILD_MESSAGES.RequestSession,
      data: instance === undefined ? null : { instance },
    },
    channel: Channel.FromContentToService,
  };
}

/**
 * Page-context transfer relay.
 *
 * Some CDNs (notably googlevideo) reject an extension-initiated fetch even with replayed
 * headers. The page itself is allowed to fetch the media, so the content script streams the body
 * to the service worker, which forwards chunks to the download worker for OPFS staging.
 */
export const RELAY_MESSAGES = {
  MediaStreamRequest: "media_stream_request",
  MediaStreamChunk: "media_stream_chunk",
  MediaStreamEnd: "media_stream_end",
  MediaStreamError: "media_stream_error",
  WorkerRelayStart: "relay_start",
  WorkerRelayChunk: "relay_chunk",
  WorkerRelayEnd: "relay_end",
  WorkerRelayAbort: "relay_abort",
} as const;

export interface MediaStreamRequestData {
  request_id: string;
  url: string;
}

export interface MediaStreamChunkData {
  request_id: string;
  data: string;
}

/** Verdict the service returns for a relayed chunk; false stops the page fetch. */
export interface MediaStreamAck {
  accepted: boolean;
}

export interface MediaStreamEndData {
  request_id: string;
  total: number;
}
