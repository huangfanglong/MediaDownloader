/**
 * Tagged wire serde used for values that cross extension context boundaries.
 *
 * Evidence: service worker `ae`/`ze` (analysis/pretty/service__main.js.pretty.js lines
 * 7121-7178; original artifact bytes ~148k). The original encodes every value as
 * `{__serde_tag: string, __serde_val?: unknown}` so that URL/Headers/Map/Set/RegExp and
 * Option/Result survive `postMessage`/`runtime.sendMessage` structured cloning.
 *
 * Hardening (adversarial review 1.3, valid): message payloads can be influenced by web pages
 * (through the page-world bridge) and by any compromised extension page. The decoder therefore
 * enforces depth/node limits, rejects cyclic input and dangerous property names, and builds
 * null-prototype objects so `__proto__` keys can never mutate a prototype chain.
 */
import {
  err,
  isOption,
  isResult,
  none,
  ok,
  some,
  type Option,
  type Result,
} from "../core/option.js";

export type SerdeTag =
  | "primitive"
  | "array"
  | "url"
  | "headers"
  | "set"
  | "map"
  | "regex"
  | "some"
  | "none"
  | "ok"
  | "err"
  | "object";

export interface Tagged<Value = unknown> {
  readonly __serde_tag: SerdeTag;
  readonly __serde_val?: Value;
}

/**
 * Wire value: always a tagged wrapper. The payload type depends on the tag (array of encoded
 * values, entry pairs for headers/map, `[source, flags]` for regex, …), so the public shape is
 * intentionally loosely typed at the wrapper level.
 */
export type EncodedValue = Tagged<unknown>;

/** Decoder resource limits. Defaults are generous for real payloads, tiny for attackers. */
export interface DecodeLimits {
  /** Maximum nesting depth (default 32). */
  maxDepth?: number;
  /** Maximum number of visited values (default 200 000). */
  maxNodes?: number;
  /** Maximum length of a single string payload (default 4 MiB). */
  maxStringLength?: number;
  /** Maximum length of an array/map/set (default 200 000). */
  maxCollectionLength?: number;
  /** Maximum number of headers in a headers payload (default 512). */
  maxHeaders?: number;
}

export const DEFAULT_DECODE_LIMITS = {
  maxDepth: 32,
  maxNodes: 200_000,
  maxStringLength: 4 * 1024 * 1024,
  maxCollectionLength: 200_000,
  maxHeaders: 512,
} as const;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const tag = <V>(name: SerdeTag, value?: V): Tagged<V> =>
  value === undefined ? { __serde_tag: name } : { __serde_tag: name, __serde_val: value };

/**
 * Encode an arbitrary runtime value into the wire form.
 *
 * Order matters: arrays/URL/Headers/Set/Map/RegExp/Option/Result must be tested before the
 * generic object case, exactly as the original does.
 */
export function encode(value: unknown): EncodedValue {
  if (value === null || value === undefined) return tag("primitive", value);
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return tag("primitive", value as string | number | boolean);
  }
  if (Array.isArray(value)) return tag("array", value.map(encode));
  if (value instanceof URL) return tag("url", value.href);
  if (value instanceof Headers) return tag("headers", [...value.entries()] as Array<[string, string]>);
  if (value instanceof Set) return tag("set", [...value.values()].map(encode));
  if (value instanceof Map) {
    return tag("map", [...value.entries()].map(([k, v]): [EncodedValue, EncodedValue] => [encode(k), encode(v)]));
  }
  if (value instanceof RegExp) return tag("regex", [value.source, value.flags]);
  if (isOption(value)) {
    return value.tag === "Some" ? tag("some", encode(value.value)) : tag("none");
  }
  if (isResult(value)) {
    return value.tag === "Ok" ? tag("ok", encode(value.value)) : tag("err", encode(value.error));
  }
  if (typeof value === "object") {
    const out: Record<string, EncodedValue> = Object.create(null) as Record<string, EncodedValue>;
    for (const [key, entry] of Object.entries(value)) out[key] = encode(entry);
    return tag("object", out);
  }
  throw new Error(`Cannot encode value of type ${type}`);
}

/**
 * Decode the wire form back into runtime values.
 *
 * Unknown tags are a protocol error. Depth/node limits prevent stack/memory exhaustion from a
 * hostile payload; cyclic structures and prototype-mutating keys are rejected outright.
 */
export function decode(value: unknown, limits: DecodeLimits = {}): unknown {
  const maxDepth = limits.maxDepth ?? DEFAULT_DECODE_LIMITS.maxDepth;
  const maxNodes = limits.maxNodes ?? DEFAULT_DECODE_LIMITS.maxNodes;
  const maxStringLength = limits.maxStringLength ?? DEFAULT_DECODE_LIMITS.maxStringLength;
  const maxCollectionLength = limits.maxCollectionLength ?? DEFAULT_DECODE_LIMITS.maxCollectionLength;
  const maxHeaders = limits.maxHeaders ?? DEFAULT_DECODE_LIMITS.maxHeaders;
  const seen = new WeakSet<object>();
  let nodes = 0;

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > maxDepth) throw new Error("serde decode: maximum depth exceeded");
    if (nodes++ > maxNodes) throw new Error("serde decode: maximum node count exceeded");
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input as object)) throw new Error("serde decode: cyclic input rejected");
    seen.add(input as object);

    const tagged = input as Tagged;
    switch (tagged.__serde_tag) {
      case "primitive": {
        const primitive = tagged.__serde_val;
        if (typeof primitive === "string" && primitive.length > maxStringLength) {
          throw new Error("serde decode: string payload exceeds limit");
        }
        return primitive;
      }
      case "array": {
        const entries = tagged.__serde_val as EncodedValue[];
        if (entries.length > maxCollectionLength) throw new Error("serde decode: collection too large");
        return entries.map((entry) => walk(entry, depth + 1));
      }
      case "url":
        return new URL(tagged.__serde_val as string);
      case "headers": {
        const pairs = tagged.__serde_val as Array<[string, string]>;
        if (!Array.isArray(pairs) || pairs.length > maxHeaders) throw new Error("serde decode: headers too large");
        return new Headers(pairs);
      }
      case "set": {
        const entries = tagged.__serde_val as EncodedValue[];
        if (entries.length > maxCollectionLength) throw new Error("serde decode: collection too large");
        return new Set(entries.map((entry) => walk(entry, depth + 1)));
      }
      case "map": {
        const pairs = tagged.__serde_val as Array<[EncodedValue, EncodedValue]>;
        if (pairs.length > maxCollectionLength) throw new Error("serde decode: collection too large");
        return new Map(
          pairs.map(([key, entry]) => [walk(key, depth + 1), walk(entry, depth + 1)] as const),
        );
      }
      case "regex": {
        const [source, flags] = tagged.__serde_val as [string, string];
        return new RegExp(source, flags);
      }
      case "some":
        return some(walk(tagged.__serde_val, depth + 1));
      case "none":
        return none;
      case "ok":
        return ok(walk(tagged.__serde_val, depth + 1));
      case "err":
        return err(walk(tagged.__serde_val, depth + 1));
      case "object": {
        // Null prototype: hostile keys can never reach a prototype chain.
        const out = Object.create(null) as Record<string, unknown>;
        for (const [key, entry] of Object.entries(tagged.__serde_val as Record<string, EncodedValue>)) {
          if (UNSAFE_KEYS.has(key)) throw new Error(`serde decode: unsafe key "${key}" rejected`);
          Object.defineProperty(out, key, {
            value: walk(entry, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return out;
      }
      default:
        throw new Error(`Unknown serde tag: ${String(tagged.__serde_tag)}`);
    }
  };

  return walk(value, 0);
}

/**
 * Round-trip helper matching the original's `je(value)` used when building download args.
 * Encode → decode, so values are plain structured-clone-safe JSON.
 */
export function structured<T>(value: T): T {
  return decode(encode(value)) as T;
}

export type { Option, Result };
