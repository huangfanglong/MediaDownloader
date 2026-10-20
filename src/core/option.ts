/**
 * Minimal Option/Result carriers.
 *
 * Why these exist: the original extension models optional fields as tagged unions on the wire
 * (`{__serde_tag:"some"|"none"}` / `"ok"|"err"`) and in its message payloads. Keeping the same
 * vocabulary in the rebuild lets us assert wire-level parity instead of silently normalising
 * `undefined` and `null` into one thing. Internal module APIs should prefer plain
 * `T | undefined`; use these at protocol boundaries.
 */

export interface Some<T> {
  readonly tag: "Some";
  readonly value: T;
}

export interface None {
  readonly tag: "None";
}

export type Option<T> = Some<T> | None;

export interface Ok<T> {
  readonly tag: "Ok";
  readonly value: T;
}

export interface Err<E> {
  readonly tag: "Err";
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export const none: None = { tag: "None" };

export const some = <T>(value: T): Option<T> => ({ tag: "Some", value });

export const ok = <T>(value: T): Result<T, never> => ({ tag: "Ok", value });

export const err = <E>(error: E): Result<never, E> => ({ tag: "Err", error });

export const isOption = (value: unknown): value is Option<unknown> => {
  if (value === null || typeof value !== "object") return false;
  const tag = (value as { tag?: unknown }).tag;
  return tag === "Some" || tag === "None";
};

export const isResult = (value: unknown): value is Result<unknown, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const tag = (value as { tag?: unknown }).tag;
  return tag === "Ok" || tag === "Err";
};

export const isSome = <T>(option: Option<T>): option is Some<T> => option.tag === "Some";

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.tag === "Ok";

export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => result.tag === "Err";

/** First `Some` wins; mirrors the original's `Option.or` chain used for titles. */
export function orOption<T>(...options: Array<Option<T>>): Option<T> {
  for (const option of options) if (option.tag === "Some") return option;
  return none;
}

export function mapOption<T, U>(option: Option<T>, fn: (value: T) => U): Option<U> {
  return option.tag === "Some" ? some(fn(option.value)) : none;
}

export function unwrapOr<T>(option: Option<T>, fallback: T): T {
  return option.tag === "Some" ? option.value : fallback;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.tag === "Ok" ? ok(fn(result.value)) : result;
}
