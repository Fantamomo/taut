// Holds back the "app opened" event Slack sends to an app whenever you open
// it (app_home_opened), and lets you approve it via a banner in the app's tabs.

import { TautPlugin } from '$taut'

const TARGET_PATH = '/api/apps.home.dispatchOpenEvent'

const ALLOW_DURATION = 60 * 60 * 1000 // 1 hour

const XHR_INFO = Symbol('taut.appHomeGate.xhrInfo')

type PendingRequest = {
  xhr: XMLHttpRequest
  body: Document | XMLHttpRequestBodyInit | null | undefined
  /** increases with every intercepted request, so the UI can tell them apart */
  seq: number
}

type Listener = () => void

export default class AppHomeGate extends TautPlugin<typeof AppHomeGate> {
  static readonly id = 'AppHomeGate'
  static readonly pluginName = 'App Home Gate'
  static readonly description =
    'Blocks the event Slack sends to an app when you open it, until you approve it'
  static readonly category = 'privacy'
  static readonly authors = ['fantamomo'] as const
  static readonly hackClubOnly = false
  static readonly defaultConfig = {
    enabled: false,
  }

  private running = false
  private originalOpen: typeof XMLHttpRequest.prototype.open | null = null
  private originalSend: typeof XMLHttpRequest.prototype.send | null = null

  private seq = 0

  /** channel id -> the most recent paused request. A newer request replaces the older one. */
  private pending = new Map<string, PendingRequest>()
  /** request id -> timestamp until which opening the app is approved */
  private listeners = new Set<Listener>()

  /** stores the channel ids of apps the user always wants to be allowed */
  private alwaysAllowStore = this.api.storage.store<string[]>('alwaysAllow', [])
  /** in memory store of apps that are approved for 1 hour */
  private allowedUntil = new Map<string, number>()

  async start() {
    this.running = true
    await this.alwaysAllowStore.ready
    if (this.api.signal.aborted) return
    this.log('Always allow:', this.alwaysAllowStore.get())
    this.patchXhr()

    // Banner in every tab of an app, between the tab bar and the content
    this.api.patchComponent<{
      channelId?: string,
      currentTabId?: string,
      tabs?: {
        autoClogProps?: {
          appId?: string,
          channelId?: string,
        },
        id?: string,
      }[]
    }>(
      'StyledChannelTabBar',
      (Original) => (props) => {
        const channelId = props.channelId
        if (!channelId || !channelId.startsWith('D')) return <Original {...props} />
        const tabs = props.tabs
        if (!tabs) return <Original {...props} />
        const appId = tabs.find((tab) => tab.autoClogProps?.appId)?.autoClogProps?.appId
        if (!appId || !appId.startsWith('A')) return <Original {...props} />

        //this.log('AppHomeGate', props)

        return (
          <>
            <Original {...props} />
            <this.AppHomeBanner key="taut-app-home-gate" id={channelId} />
          </>
        )
      }
    )

    this.injectStyles()
    this.log('Started')
  }

  stop(): void {
    this.running = false

    // we override the original open and send methods to intercept requests
    if (this.originalOpen) {
      XMLHttpRequest.prototype.open = this.originalOpen
      this.originalOpen = null
    }
    if (this.originalSend) {
      XMLHttpRequest.prototype.send = this.originalSend
      this.originalSend = null
    }
    this.pending.clear()
    this.emit()
    this.log('Stopped')
  }

  private patchXhr() {
    const plugin = this
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    this.originalOpen = originalOpen
    this.originalSend = originalSend

    XMLHttpRequest.prototype.open = function (
      this: any,
      method: string,
      url: string | URL,
      ...rest: any[]
    ) {
      try {
        this[XHR_INFO] = { url: new URL(url.toString(), location.href) }
      } catch {
        this[XHR_INFO] = undefined
      }
      return Reflect.apply(originalOpen, this, [method, url, ...rest])
    } as typeof XMLHttpRequest.prototype.open

    XMLHttpRequest.prototype.send = function (
      this: any,
      body?: Document | XMLHttpRequestBodyInit | null
    ) {
      const info = this[XHR_INFO] as { url: URL } | undefined
      if (!plugin.running || !info || info.url.pathname !== TARGET_PATH) {
        return originalSend.call(this, body)
      }

      //plugin.log('Intercepted request', body)

      const id = plugin.extractId(body)
      if (!id) {
        plugin.log('No id in request, letting it through', info.url.href)
        return originalSend.call(this, body)
      }

      if (plugin.isAllowed(id)) {
        return originalSend.call(this, body)
      }

      // every intercepted request (also a later one, after the user already
      // dismissed the banner or ignored it) replaces the previous entry and notifies the UI,
      // so the banner shows up again right away. Deliberately no send().
      plugin.log('Paused app open event for', id)
      plugin.pending.set(id, { xhr: this, body, seq: ++plugin.seq })
      plugin.emit()
    } as typeof XMLHttpRequest.prototype.send
  }

  private extractId(body: unknown): string | undefined {
    let params: URLSearchParams | FormData | undefined
    if (typeof body === 'string') params = new URLSearchParams(body)
    else if (body instanceof URLSearchParams) params = body
    else if (body instanceof FormData) params = body
    if (!params) return undefined

    const id = params.get('id')
    return typeof id === 'string' && id ? id : undefined
  }

  private release(id: string) {
    const request = this.pending.get(id)
    if (!request || !this.originalSend) return
    this.pending.delete(id)
    this.emit()
    this.originalSend.call(request.xhr, request.body)
  }

  private dismiss(id: string) {
    if (this.pending.delete(id)) this.emit()
  }

  private isAllowed(id: string): boolean {
    if (this.alwaysAllowStore.get()?.includes(id)) return true
    const until = this.allowedUntil.get(id)
    if (until === undefined) return false
    if (until > Date.now()) return true
    this.allowedUntil.delete(id)
    return false
  }

  private approveOnce(id: string) {
    this.release(id)
  }

  private approveForAWhile(id: string) {
    this.allowedUntil.set(id, Date.now() + ALLOW_DURATION)
    this.release(id)
  }

  private approveAlways(id: string) {
    this.alwaysAllowStore.update((ids) => {
      const next = [...ids]
      next.push(id)
      return next
    })
      .catch((err) => this.log('Could not save', err))
    this.release(id)
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }

  private subscribe = (listener: Listener) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private usePending(id: string): PendingRequest | undefined {
    return React.useSyncExternalStore(this.subscribe, () => this.pending.get(id))
  }

  private AppHomeBanner = (props: { id: string }) => {
    //this.log('AppHomeBanner', props.id)
    const request = this.usePending(props.id)
    if (!request) return null
    return <this.BannerContent key={request.seq} id={props.id} />
  }

  private BannerContent = (props: { id: string }) => {
    this.log('BannerContent', props.id)
    const { id } = props
    const [menuOpen, setMenuOpen] = React.useState(false)
    const splitRef = React.useRef<HTMLDivElement>(null)

    React.useEffect(() => {
      if (!menuOpen) return
      const onMouseDown = (e: MouseEvent) => {
        if (!splitRef.current?.contains(e.target as Node)) setMenuOpen(false)
      }
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setMenuOpen(false)
      }
      document.addEventListener('mousedown', onMouseDown, true)
      document.addEventListener('keydown', onKeyDown, true)
      return () => {
        document.removeEventListener('mousedown', onMouseDown, true)
        document.removeEventListener('keydown', onKeyDown, true)
      }
    }, [menuOpen])

    const run = (action: (id: string) => void) => {
      setMenuOpen(false)
      action(id)
    }

    return (
      <div className="taut-app-home-gate" role="alert">
        <svg
          className="taut-app-home-gate__icon"
          viewBox="0 0 20 20"
          width="20"
          height="20"
          aria-hidden="true"
        >
          <path
            d="M10 2 3.5 4.6v4.7c0 4 2.7 7.4 6.5 8.7 3.8-1.3 6.5-4.7 6.5-8.7V4.6L10 2Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M10 6.5v4.2M10 13.2v.1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>

        <div className="taut-app-home-gate__text">
          <div className="taut-app-home-gate__title">
            This app doesn't know you opened it
          </div>
          <div className="taut-app-home-gate__body">
            Slack normally tells an app the moment you open it by sending it an{' '}
            <code>app_home_opened</code> event. Taut is holding that event back.
          </div>
        </div>

        <div className="taut-app-home-gate__actions">
          <button
            className="taut-app-home-gate__btn taut-app-home-gate__btn--ghost"
            onClick={() => run((i) => this.dismiss(i))}
          >
            Dismiss
          </button>

          <div className="taut-app-home-gate__split" ref={splitRef}>
            <button
              className="taut-app-home-gate__btn taut-app-home-gate__btn--primary taut-app-home-gate__split-main"
              onClick={() => run((i) => this.approveOnce(i))}
            >
              Approve
            </button>
            <button
              className="taut-app-home-gate__btn taut-app-home-gate__btn--primary taut-app-home-gate__split-toggle"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More approval options"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path
                  d="m2.5 4.5 3.5 3.5 3.5-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {menuOpen ? (
              <div className="taut-app-home-gate__menu" role="menu">
                <button
                  className="taut-app-home-gate__menu-item"
                  role="menuitem"
                  onClick={() => run((i) => this.approveOnce(i))}
                >
                  <span>Approve once</span>
                  <small>Only for this time</small>
                </button>
                <button
                  className="taut-app-home-gate__menu-item"
                  role="menuitem"
                  onClick={() => run((i) => this.approveForAWhile(i))}
                >
                  <span>Approve for 1 hour</span>
                  <small>Until the hour is up or Slack reloads</small>
                </button>
                <button
                  className="taut-app-home-gate__menu-item"
                  role="menuitem"
                  onClick={() => run((i) => this.approveAlways(i))}
                >
                  <span>Always approve this app</span>
                  <small>Never block it again</small>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  private injectStyles() {
    this.api.setStyle(`
      .taut-app-home-gate {
        position: relative;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 14px;
        padding: 10px 20px;
        font-size: 13px;
        line-height: 1.4;
        background: rgba(242, 199, 68, 0.16);
        border-bottom: 1px solid rgba(var(--sk_foreground_low, 29, 28, 29), .13);
      }
      .taut-app-home-gate__icon {
        flex-shrink: 0;
        opacity: 0.75;
      }
      .taut-app-home-gate__text {
        flex: 1 1 260px;
        min-width: 0;
      }
      .taut-app-home-gate__title {
        font-weight: 700;
      }
      .taut-app-home-gate__body {
        opacity: 0.8;
      }
      .taut-app-home-gate__body code {
        padding: 1px 4px;
        border-radius: 4px;
        font-size: 12px;
        background: rgba(134, 134, 134, 0.16);
      }
      .taut-app-home-gate__actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
      }
      .taut-app-home-gate__btn {
        border: 1px solid rgba(134, 134, 134, 0.35);
        border-radius: 6px;
        padding: 6px 12px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        background: transparent;
        color: inherit;
      }
      .taut-app-home-gate__btn:hover {
        background: rgba(134, 134, 134, 0.14);
      }
      .taut-app-home-gate__btn--ghost {
        border-color: transparent;
        opacity: 0.8;
      }
      .taut-app-home-gate__btn--primary {
        background: #007a5a;
        border-color: #007a5a;
        color: white;
      }
      .taut-app-home-gate__btn--primary:hover {
        background: #006a4e;
      }
      .taut-app-home-gate__split {
        position: relative;
        display: inline-flex;
      }
      .taut-app-home-gate__split-main {
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
      }
      .taut-app-home-gate__split-toggle {
        display: inline-flex;
        align-items: center;
        padding: 6px 8px;
        border-top-left-radius: 0;
        border-bottom-left-radius: 0;
        border-left-color: rgba(255, 255, 255, 0.35);
      }
      .taut-app-home-gate__menu {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        z-index: 1000;
        min-width: 250px;
        padding: 4px;
        border-radius: 8px;
        border: 1px solid rgba(134, 134, 134, 0.3);
        background: rgb(var(--sk_primary_background, 255, 255, 255));
        color: rgb(var(--sk_primary_foreground, 29, 28, 29));
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
      }
      .taut-app-home-gate__menu-item {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
        width: 100%;
        padding: 7px 10px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font-size: 13px;
        text-align: left;
        cursor: pointer;
      }
      .taut-app-home-gate__menu-item:hover {
        background: rgba(134, 134, 134, 0.16);
      }
      .taut-app-home-gate__menu-item small {
        font-size: 11px;
        opacity: 0.65;
      }
    `)
  }
}