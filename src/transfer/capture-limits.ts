/**
 * Bounds for values captured from the network and the page bridge.
 *
 * One definition for the sniffer/hook/healing layers: the same URL limit was repeated as separate
 * constants and bare `8192` literals in the service worker, header replay and content-script
 * sanitisers, so a change in one place silently left the others behind.
 */

/** Longest URL/header value worth remembering from an observed request (bytes of text). */
export const MAX_CAPTURED_URL_LENGTH = 8192;

/** Longest single request-header value replayed through the DNR rules. */
export const MAX_CAPTURED_HEADER_LENGTH = 8192;
