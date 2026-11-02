/**
 * The page-context relay must not trust a body it cannot place at the requested offset, and it
 * must not allocate an ignored-range body before deciding that: a server answering a 2 MiB range
 * request with the whole file (or the same chunk again) used to be relayed until the advertised
 * size, and the body was read with an uncapped `arrayBuffer()`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMediaStreamRequest } from "../src/extension/content-script.js";
import { RELAY_MESSAGES } from "../src/protocol/rebuild-messages.js";

const RELAY_URL = "https://cdn.test/videoplayback?id=1&itag=18&clen=4194304";
const CHUNK_BYTES = 2 * 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
});

interface SentMessage {
  name: string;
  data: Record<string, unknown>;
}

function response(options: {
  status: number;
  contentRange?: string;
  bytes?: Uint8Array;
  onRead?: () => void;
}): Partial<Response> {
  return {
    status: options.status,
    ok: options.status >= 200 && options.status < 300,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-range" ? options.contentRange ?? null : null),
    } as unknown as Headers,
    arrayBuffer: async () => {
      options.onRead?.();
      const bytes = options.bytes ?? new Uint8Array(0);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  } as Partial<Response>;
}

function runtimeWith(sent: SentMessage[]): unknown {
  return {
    id: "fake-extension-id",
    sendMessage: async (envelope: { msg: SentMessage }) => {
      sent.push(envelope.msg);
      return { accepted: true };
    },
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
  };
}

describe("page relay range integrity", () => {
  it("rejects a server that ignores Range before reading the ignored body", async () => {
    let ignoredBodyReads = 0;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return response({
            status: 206,
            contentRange: `bytes 0-${CHUNK_BYTES - 1}/4194304`,
            bytes: new Uint8Array(CHUNK_BYTES).fill(1),
          });
        }
        // Every later request is answered with HTTP 200 (range ignored) and a body that is short
        // enough for the old loop to treat as EOF after reading it.
        return response({
          status: 200,
          bytes: new Uint8Array(CHUNK_BYTES / 2).fill(1),
          onRead: () => {
            ignoredBodyReads += 1;
          },
        });
      }),
    );
    const sent: SentMessage[] = [];
    await handleMediaStreamRequest(runtimeWith(sent) as never, {
      request_id: "range-integrity",
      url: RELAY_URL,
    });

    expect(ignoredBodyReads).toBe(0);
    expect(sent.some((message) => message.name === RELAY_MESSAGES.MediaStreamError)).toBe(true);
    expect(sent.some((message) => message.name === RELAY_MESSAGES.MediaStreamEnd)).toBe(false);
  });
});
