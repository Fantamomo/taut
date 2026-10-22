// Blocks Slack's built-in tracking and analytics requests

import { TautPlugin } from '$taut'

const TRACKING_PATTERNS = [
  '*://slackb.com/*',
  '*://*.slackb.com/*',
  '*://slack.com/beacon/*',
  '*://*.slack.com/beacon/*',
  '*://slack.com/clog/*',
  '*://*.slack.com/clog/*',
  '*://slack.com/api/*/beacon*',
  '*://*.slack.com/api/*/beacon*',
  '*://slack.com/api/*/clog*',
  '*://*.slack.com/api/*/clog*',
  '*://slack.com/api/*/science*',
  '*://*.slack.com/api/*/science*',
  '*://slack.com/api/*/metrics*',
  '*://*.slack.com/api/*/metrics*',
  '*://slack.com/api/*/typing*',
  '*://*.slack.com/api/*/typing*',
  '*://*.slack-edge.com/*/slack_beacon.*',
]

export default class NoTrack extends TautPlugin<typeof NoTrack> {
  static readonly id = 'NoTrack'
  static readonly pluginName = 'No Tracking'
  static readonly description =
    "Blocks Slack's built-in tracking and analytics requests"
  static readonly authors = ['rowan', 'jeremy'] as const
  static readonly category = 'privacy'
  static readonly defaultConfig = {
    enabled: true,
  }

  private matchers: RegExp[] = []
  private running = false
  private blockedXHRs = new WeakSet<XMLHttpRequest>()
  private restores: (() => void)[] = []

  private isBlocked(url: string): boolean {
    return this.matchers.some((re) => re.test(url))
  }

  private static urlString(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    return (input as Request).url
  }

  private exportByName<T = any>(name: string): Promise<T> {
    return this.api.waitForExport<T>(this.api.byName(name))
  }

  // restored on stop only while target[key] is still value
  private replace<T extends object, K extends keyof T>(
    target: T,
    key: K,
    value: T[K]
  ): void {
    const own = Object.getOwnPropertyDescriptor(target, key)
    target[key] = value
    this.restores.push(() => {
      if (target[key] !== value) return
      if (own) Object.defineProperty(target, key, own)
      else delete target[key]
    })
  }

  private async stopTracing(): Promise<void> {
    const getGenericTracer =
      await this.exportByName<() => any>('getGenericTracer')
    if (!this.running) return
    const proto = Object.getPrototypeOf(getGenericTracer())
    if (typeof proto.shouldSample !== 'function') return
    this.replace(proto, 'shouldSample', () => false)
  }

  private async stopMetrics(): Promise<void> {
    const [getGenericTelemeter, getNoopTelemeter] = await Promise.all([
      this.exportByName<() => any>('getGenericTelemeter'),
      this.exportByName<() => any>('getNoopTelemeter'),
    ])
    if (!this.running) return

    const real = Object.getPrototypeOf(getGenericTelemeter())
    const noop = Object.getPrototypeOf(getNoopTelemeter())
    const keep = new Set([
      'clearMarks',
      'clearMeasures',
      'emptyMetrics',
      'measureAndClear',
    ])
    for (const name of Object.getOwnPropertyNames(noop)) {
      if (name === 'constructor' || keep.has(name)) continue
      if (typeof noop[name] !== 'function') continue
      this.replace(real, name, noop[name])
    }
  }

  start(): void {
    this.running = true
    this.matchers = TRACKING_PATTERNS.map(globToRegex)

    const fetch = window.fetch
    this.replace(window, 'fetch', (input, init) =>
      this.isBlocked(NoTrack.urlString(input))
        ? Promise.reject(new TypeError('Failed to fetch'))
        : fetch(input, init)
    )

    const plugin = this
    const { open, send } = XMLHttpRequest.prototype
    this.replace(
      XMLHttpRequest.prototype,
      'open',
      function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...rest: any[]
      ) {
        Reflect.deleteProperty(this, 'readyState')
        if (plugin.isBlocked(url.toString())) plugin.blockedXHRs.add(this)
        else plugin.blockedXHRs.delete(this)
        return Reflect.apply(open, this, [method, url, ...rest])
      }
    )
    this.replace(
      XMLHttpRequest.prototype,
      'send',
      function (
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null
      ) {
        if (!plugin.blockedXHRs.has(this))
          return Reflect.apply(send, this, [body])
        // fails like a network error so the sender gives up
        setTimeout(() => {
          Object.defineProperty(this, 'readyState', {
            value: XMLHttpRequest.DONE,
            configurable: true,
          })
          this.dispatchEvent(new Event('readystatechange'))
          this.dispatchEvent(new ProgressEvent('error'))
          this.dispatchEvent(new ProgressEvent('loadend'))
        })
      }
    )

    if (typeof navigator.sendBeacon === 'function') {
      const sendBeacon = navigator.sendBeacon.bind(navigator)
      this.replace(navigator, 'sendBeacon', (url, data) =>
        this.isBlocked(NoTrack.urlString(url)) ? true : sendBeacon(url, data)
      )
    }

    const failed = (error: unknown) =>
      this.log('Could not stop a metrics pipeline', error)
    this.stopTracing().catch(failed)
    this.stopMetrics().catch(failed)

    this.log('Started, blocking', this.matchers.length, 'patterns')
  }

  stop(): void {
    this.running = false
    for (const restore of this.restores.reverse()) restore()
    this.restores = []
    this.matchers = []
    this.log('Stopped')
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}
