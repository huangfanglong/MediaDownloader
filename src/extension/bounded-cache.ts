interface CacheEntry<Value> {
  value: Value;
  at: number;
}

/** A small LRU cache that releases evicted resources such as object URLs. */
export class BoundedCache<Key, Value> {
  private readonly entries = new Map<Key, CacheEntry<Value>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly onEvict: (value: Value, key: Key) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: Key): Value | undefined {
    this.prune();
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: Key, value: Value): void {
    this.prune();
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.onEvict(previous.value, key);
    }
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > Math.max(1, this.maxEntries)) {
      const oldest = this.entries.keys().next().value as Key;
      const entry = this.entries.get(oldest) as CacheEntry<Value>;
      this.entries.delete(oldest);
      this.onEvict(entry.value, oldest);
    }
  }

  prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at < this.ttlMs) continue;
      this.entries.delete(key);
      this.onEvict(entry.value, key);
    }
  }

  clear(): void {
    for (const [key, entry] of this.entries) this.onEvict(entry.value, key);
    this.entries.clear();
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }
}
