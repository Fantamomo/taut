import type { BlobStore } from '../../shared/TautBridge'

type CacheEntry<T> = { value: T; ts: number }
export type CacheOptions = {
  ttl?: number
  /** past this many entries, the oldest writes are dropped */
  maxSize?: number
  /** keeps expired entries, and `fetch` returns one when its fetcher throws */
  staleIfError?: boolean
}

const WRITE_DELAY = 2000

/** persistent cache, `ttl` is in ms and concurrent `fetch`es of one key share a call */
export class Cache<T> {
  /** in write order, oldest first */
  private memory = new Map<string, CacheEntry<T>>()
  private pending = new Map<string, Promise<T>>()
  private generation = 0
  private writes: Promise<unknown> = Promise.resolve()
  private writeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private blob: BlobStore,
    private storageKey: string,
    private options: CacheOptions = {}
  ) {}

  private fresh(entry: CacheEntry<T>): boolean {
    const { ttl } = this.options
    return ttl === undefined || Date.now() - entry.ts < ttl
  }

  private queue(write: () => Promise<unknown>) {
    this.writes = this.writes.catch(() => {}).then(write)
  }

  private persist() {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      const value = JSON.stringify(Object.fromEntries(this.memory))
      this.queue(() => this.blob.write(this.storageKey, value))
    }, WRITE_DELAY)
  }

  private evict() {
    const { maxSize } = this.options
    if (maxSize === undefined) return
    for (const key of this.memory.keys()) {
      if (this.memory.size <= maxSize) return
      this.memory.delete(key)
    }
  }

  /** adds the saved entries, keeping any set since */
  async load() {
    const generation = this.generation
    let saved: Record<string, CacheEntry<T>>
    try {
      await this.writes.catch(() => {})
      saved = JSON.parse((await this.blob.read(this.storageKey)) ?? '{}')
    } catch {
      return
    }
    if (generation !== this.generation) return
    const loaded = Object.entries(saved)
      .filter(
        ([key, entry]) =>
          typeof entry?.ts === 'number' &&
          !this.memory.has(key) &&
          (this.options.staleIfError || this.fresh(entry))
      )
      .sort((a, b) => a[1].ts - b[1].ts)
    this.memory = new Map([...loaded, ...this.memory])
    this.evict()
  }

  get(key: string): T | undefined {
    const entry = this.memory.get(key)
    return entry && this.fresh(entry) ? entry.value : undefined
  }

  set(key: string, value: T): void {
    this.memory.delete(key)
    this.memory.set(key, { value, ts: Date.now() })
    this.evict()
    this.persist()
  }

  async fetch(key: string, fetcher: () => Promise<T>): Promise<T> {
    const entry = this.memory.get(key)
    if (entry && this.fresh(entry)) return entry.value

    const existing = this.pending.get(key)
    if (existing) return existing

    const generation = this.generation
    const promise: Promise<T> = fetcher()
      .then(
        (value) => {
          if (generation === this.generation) this.set(key, value)
          return value
        },
        (error) => {
          const stale = this.memory.get(key)
          if (this.options.staleIfError && stale) return stale.value
          throw error
        }
      )
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key)
      })
    this.pending.set(key, promise)
    return promise
  }

  clear(): void {
    this.generation++
    this.memory.clear()
    this.pending.clear()
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = null
    this.queue(() => this.blob.delete(this.storageKey))
  }
}

export function bindCache(blob: BlobStore) {
  return class BoundCache<T> extends Cache<T> {
    constructor(cacheKey: string, options?: CacheOptions) {
      super(blob, cacheKey, options)
    }
  }
}
