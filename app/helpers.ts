export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false

  const aObject = a as Record<string, unknown>
  const bObject = b as Record<string, unknown>
  const aKeys = Object.keys(aObject)
  const bKeys = Object.keys(bObject)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.hasOwn(bObject, key)) return false
    if (!deepEqual(aObject[key], bObject[key])) return false
  }
  return true
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const reported = new Set<string>()
/** resolves undefined if `work` hasn't settled within `ms`, logging once that `what` is unavailable */
export function within<T>(
  /** a promise, or a function returning a promise that can be stopped with the signal */
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  ms: number,
  what?: string,
  /** also aborts the work's signal */
  signal?: AbortSignal
): Promise<T | undefined> {
  const deadline = new AbortController()
  const promise =
    typeof work === 'function'
      ? work(
          signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal
        )
      : work
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (what && !reported.has(what)) {
        reported.add(what)
        console.error(`[Taut] ${what} is unavailable`)
      }
      deadline.abort()
      resolve(undefined)
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** runs `attempt` up to `tries` times until it returns a value, with exponential backoff and full jitter */
export async function retry<T>(
  attempt: () => Promise<T | undefined>,
  { tries = 3, baseMs = 1000, maxMs = 30_000 } = {}
): Promise<T | undefined> {
  for (let i = 0; ; i++) {
    const result = await attempt()
    if (result !== undefined || i >= tries - 1) return result
    await sleep(Math.random() * Math.min(maxMs, baseMs * 2 ** i))
  }
}
