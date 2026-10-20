// Shows which apps a user has installed on their profile, and who has
// installed/authorized a given app on that app's profile/about page.

import { opt, TautPlugin } from '$taut'
import type { NormalizedBridge } from '../app/bridgeCompat.ts'
import { getActiveTeam } from '../app/slack/localConfig.ts'

const MARKETPLACE_BASE = 'https://slack.com/marketplace'

// installed-apps list is fairly static, no need to refetch constantly
const INSTALLS_TTL = 30 * 60 * 1000 // 30 min
// marketplace page data (authorizations, features, bot memberships)
const APP_PAGE_TTL = 60 * 60 * 1000 // 60 min

// the secret names for writing the secrets
// while there is a config option called secret to store secrets,
// it only allows the user to write input, so we wouldn't be able to modify them
const WEB_TOKENS = 'installedApps.webToken'
const WEB_TOKEN_DECLINED = 'installedApps.webTokenDeclined'

// list of api request error, that we use to determine if a user has insufficient permissions
const PERMISSION_ERROR_HINTS = [
  'invalid_auth',
  'enterprise_is_restricted',
  'not_authorized',
  'missing_scope',
  'account_inactive',
]

type InstalledApp = {
  id: string
  name: string
  description?: string
  app_directory_url?: string
  icons?: Record<string, string>
  developer_type?: string
  is_internal?: boolean
  is_app_directory_approved?: boolean
  is_certified?: boolean
}

type AppDirectoryFeatures = {
  appId: string
  appName: string
  appIcon: string
  isAiApp?: boolean
  isAgentApp?: boolean
}

type Authorization = {
  date: number
  userDisplayName: string
  encodedUserLink: string // this is actually the user's id, e.g. "U0123ABC"
  fullDescription: string
}

type AppDirectoryAuthorizations = {
  appId: string
  appName: string
  appIcons: Record<string, string>
  authorizations: Authorization[]
}

type AppDirectoryBotUser = {
  botUsername: string
  memberships: string[]
  otherGroups: number
}

type AppPageData = {
  features?: AppDirectoryFeatures
  authorizations?: AppDirectoryAuthorizations
  botUser?: AppDirectoryBotUser
}

type AppProps = {
  appId?: string
  appUserId?: string
  memberId?: string
}

type ProfileProps = {
  member?: {
    id?: string
    display_name?: string
    real_name?: string
    name?: string
  }
}

function iconOf(icons: Record<string, string> | undefined): string | undefined {
  if (!icons) return undefined
  return (
    icons.image_48 ??
    icons.image_36 ??
    icons.image_32 ??
    icons.image_72 ??
    Object.values(icons)[0]
  )
}

export default class InstalledApps extends TautPlugin<typeof InstalledApps> {
  static readonly id = 'InstalledApps'
  static readonly pluginName = 'Installed Apps'
  static readonly description =
    'Shows which apps a user has installed on their profile, and who has installed a given app on its profile/about page'
  static readonly authors = ['fantamomo'] as const
  static readonly category = 'app'
  static readonly hackClubOnly = false
  static readonly defaultConfig = {
    enabled: false,
    // we store secrets in the secret store, which is not directly connected to this app,
    // so the clear cache/data button in the plugin settings cannot remove them. So we use this config value,
    removeTokens: opt(
      false,
      'Set to true to remove tokens (unselect after, to readd tokens)'
    ),
  }

  /** key: user id -> apps that admin.apps.installed.list reports for them */
  private installsCache = new this.api.Cache<InstalledApp[] | null>(
    'installed_apps',
    { ttl: INSTALLS_TTL, maxSize: 2000 }
  )
  /** key: app id -> parsed data-automount-props from the marketplace page */
  private appPageCache = new this.api.Cache<AppPageData | null>(
    'app_directory_page',
    { ttl: APP_PAGE_TTL, maxSize: 500 }
  )

  /** in-flight token dialog, so parallel profile panes share one prompt */
  private tokenPromptPending: Promise<string | null> | null = null

  // I couldn't find a better way to get the bridge which has the methods for storing secrets
  private bridge = (globalThis as any).__tautPluginManager
    .bridge as NormalizedBridge

  private useWebToken = false

  async start() {
    if (this.config.removeTokens) {
      this.log('Removing secrets')

      // only in taut 3.0.0 was the deleteSecret method added
      // so a simple check if it exists, if not we just write an empty object
      if (this.bridge.deleteSecret) {
        await this.bridge.deleteSecret(WEB_TOKENS)
        await this.bridge.deleteSecret(WEB_TOKEN_DECLINED)
      } else {
        await this.bridge.writeSecret(WEB_TOKENS, '{}')
        await this.bridge.writeSecret(WEB_TOKEN_DECLINED, '{}')
      }
    }

    await this.installsCache.load()
    if (this.api.signal.aborted) return
    await this.appPageCache.load()
    if (this.api.signal.aborted) return

    // patching the Content component to add the AppInstallersBlock on the app profile page
    this.api.patchComponent<{ children?: unknown }>(
      'Content',
      (Original) => (props) => {
        const children = (props as any)?.children
        const existing = children?.props?.children
        if (!Array.isArray(existing)) return <Original {...props} />

        // finding the AppDetailsOverflow component, which contains all the info we need
        // (I tried patching AppDetailsOverflow but then the resulting layout was broken with no way (that i know) to fix it)
        const info = this.findAppDetailsOverflow(props.children)
        const appId = info?.appId

        if (!appId) return <Original {...props} />

        const newChildren = [
          ...existing,
          <this.AppInstallersBlock appId={info.appId} />,
        ]

        return <Original {...props} children={newChildren} />
      }
    )

    // patching the RimetoProfilePresence component
    // (that is on every user profile and tells if the user is currently active) to add the InstalledAppsBlock
    this.api.patchComponent<ProfileProps>(
      'RimetoProfilePresence',
      (Original) => (props) => {
        const userId = props.member?.id
        if (!userId) return <Original {...props} />
        return (
          <>
            <Original {...props} />
            <this.InstalledAppsBlock userId={userId} />
          </>
        )
      }
    )

    // patching the AboutPage component to add the AppInstallersBlock on the apps about page
    this.api.patchComponent<{
      appId?: string
      children?: unknown
    }>('AboutPage', (Original) => (props) => {
      const appId = props.appId
      if (!appId || !appId.startsWith('A')) return <Original {...props} />

      // the wrappers are necessary so that a scroll bar is shown
      return (
        <div className="taut-about-scroll-wrapper">
          <div className="taut-about-scroll-wrapper__original">
            <Original {...props} />
          </div>
          <this.AppInstallersBlock
            key="taut-app-installers"
            appId={appId}
            app_about_screen={true}
          />
        </div>
      )
    })

    this.injectStyles()
    this.log('Started')
  }

  private findAppDetailsOverflow(
    node: unknown,
    depth = 0
  ): AppProps | undefined {
    if (!node || depth > 12) return undefined

    if (Array.isArray(node)) {
      for (const child of node) {
        const found = this.findAppDetailsOverflow(child, depth + 1)
        if (found) return found
      }
      return undefined
    }

    if (typeof node !== 'object') return undefined

    const props = (node as any)?.props
    if (this.isProfileProps(props)) return props as AppProps

    if (props?.children)
      return this.findAppDetailsOverflow(props.children, depth + 1)
    return undefined
  }

  private isProfileProps(obj: unknown): obj is AppProps {
    if (typeof obj !== 'object' || obj === null) {
      return false
    }

    const profile = obj as Record<string, unknown>

    return (
      (profile.appId !== undefined || typeof profile.appId === 'string') &&
      (profile.appUserId !== undefined ||
        typeof profile.appUserId === 'string') &&
      (profile.memberId !== undefined ||
        typeof profile.memberId === 'string') &&
      (profile.isAppVIP !== undefined || typeof profile.isAppVIP === 'boolean')
    )
  }

  // --- web token for admin.apps.installed.list --------------------------

  private looksLikePermissionError(message: string): boolean {
    const lower = message.toLowerCase()
    return PERMISSION_ERROR_HINTS.some((hint) => lower.includes(hint))
  }

  private async tryFetchInstalledApps(
    userId: string,
    tokenOverride?: string
  ): Promise<
    { ok: true; apps: InstalledApp[] } | { ok: false; error: string }
  > {
    // that is actually crazy, the admin.apps.installed.list is an undocumented API endpoint,
    // but it is used on the app mange page (which is accessible by anyone) to show the installed apps,+
    // with a slack client token we cannot fetch the installed apps, but with a web token (of the same account) we can
    // thats the reason for the tokenOverride parameter
    // (ask salesforce why)
    try {
      const apps: InstalledApp[] = []
      let nextCursor: string | undefined
      let iter = 0
      do {
        const res = await this.api.userAPI<any>(
          'admin.apps.installed.list',
          {
            user_id: userId,
            limit: '100',
            legacy_integrations: 'false',
            ...(nextCursor ? { cursor: nextCursor } : {}),
            // userAPI already provides the client token, but we can override it
            ...(tokenOverride ? { token: tokenOverride } : {}),
          },
          {
            signal: this.api.signal,
          }
        )
        this.log('Fetched installed apps:', res)
        apps.push(...(res.apps ?? []))
        iter++
        if (iter > 15) {
          // no normal person has over 15.000 apps
          break
        }
        nextCursor = res.response_metadata?.next_cursor ?? undefined
      } while (nextCursor)

      return { ok: true, apps: apps }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** the saved web token for this team, or null if we don't have one / user declined */
  private async ensureWebToken(): Promise<string | null> {
    const team = getActiveTeam()?.id

    if (!team) return null

    const tokensText = await this.bridge.readSecret(WEB_TOKENS)
    if (tokensText) {
      const tokens: { [key: string]: string } = JSON.parse(tokensText)
      if (tokens[team]) return tokens[team]
    }

    const declinedText = await this.bridge.readSecret(WEB_TOKEN_DECLINED)
    if (declinedText) {
      const declined: { [key: string]: boolean } = JSON.parse(declinedText)
      if (declined[team]) return null
    }

    // several profile panes could theoretically hit the permission error around the same
    // time, only show one dialog and let everyone else wait on its result
    if (!this.tokenPromptPending) {
      this.tokenPromptPending = this.promptForToken(team).finally(() => {
        this.tokenPromptPending = null
      })
    }
    return this.tokenPromptPending
  }

  private promptForToken(team: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (value: string | null) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      this.log('Opening token prompt')

      if (this.config.removeTokens) {
        this.api.modal.openModal({
          title: 'Please unselect the removeTokens option in the settings',
          submitText: 'Close',
          showCancelButton: false,
          onClose: () => {
            settle(null)
          },
          onSubmit: () => {
            settle(null)
          },
          body: (
            <div>
              <p>
                The removeTokens option is currently enabled in the settings.
                Please disable it if you want to use this feature.
              </p>
            </div>
          ),
        })
      }

      this.api.modal.openModal({
        title: 'Token for installed apps',
        submitText: 'Close',
        showCancelButton: false,
        onClose: () => {
          settle(null)
        },
        onSubmit: () => {
          settle(null)
        },
        body: (
          <this.TokenPromptBody
            onSave={async (token) => {
              const storedTokensText =
                (await this.bridge.readSecret(WEB_TOKENS)) ?? '{}'
              const storedTokens: { [key: string]: string } =
                JSON.parse(storedTokensText)
              const newTokens = JSON.stringify({
                ...storedTokens,
                [team]: token,
              })
              await this.bridge.writeSecret(WEB_TOKENS, newTokens)

              this.log('Saved token')
              settle(token)
              ;(this.api.modal as any)?.closeModal?.()
            }}
            onDecline={async () => {
              const declinedText =
                (await this.bridge.readSecret(WEB_TOKEN_DECLINED)) ?? '{}'
              const declined: { [key: string]: boolean } =
                JSON.parse(declinedText)
              const newDeclined = JSON.stringify({ ...declined, [team]: true })
              await this.bridge.writeSecret(WEB_TOKEN_DECLINED, newDeclined)

              this.log('Declined token')
              settle(null)
              ;(this.api.modal as any)?.closeModal?.()
            }}
          />
        ),
      })
    })
  }

  private TokenPromptBody = (props: {
    onSave: (token: string) => void
    onDecline: () => void
  }) => {
    const [value, setValue] = React.useState('')
    const [saving, setSaving] = React.useState(false)

    const save = async () => {
      const token = value.trim()
      if (!token) return
      setSaving(true)
      await props.onSave(token)
    }

    return (
      <div className="taut-installed-apps__token-prompt">
        <p>
          We dont have the required rights to access installed apps information.
          If you want to use this feature, just open a browser and copy the
          xoxp- token from there. (Due to unknown reasons, the web app token has
          more rights than the current client token.)
        </p>
        <textarea
          className="taut-installed-apps__token-input"
          placeholder="xoxp-..."
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          rows={3}
        />
        <div className="taut-installed-apps__token-actions">
          <button
            className="taut-installed-apps__token-btn taut-installed-apps__token-btn--secondary"
            onClick={props.onDecline}
          >
            No thanks
          </button>
          <button
            className="taut-installed-apps__token-btn taut-installed-apps__token-btn--primary"
            disabled={!value.trim() || saving}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    )
  }

  // --- installed apps (per user) ------------------------------------------

  private async fetchInstalledApps(
    userId: string
  ): Promise<InstalledApp[] | null> {
    return this.installsCache.fetch(userId, async () => {
      if (!this.useWebToken) {
        // first attempt: try with the current token
        const first = await this.tryFetchInstalledApps(userId)
        if (first.ok) return first.apps
        if (!this.looksLikePermissionError(first.error)) {
          // seams like it failed due to some other reason
          this.log('fetchInstalledApps failed', first.error)
          return null
        }
      }

      // second attempt: try with the web token
      const token = await this.ensureWebToken()
      if (!token) return null
      // set to true, to avoid retrying with the normal token every time
      this.useWebToken = true

      const second = await this.tryFetchInstalledApps(userId, token)
      if (second.ok) return second.apps

      this.log('fetchInstalledApps failed even with web token', second.error)
      this.useWebToken = false
      return null
    })
  }

  private useInstalledApps(userId: string | undefined) {
    const [apps, setApps] = React.useState<InstalledApp[] | null>(() =>
      userId ? (this.installsCache.get(userId) ?? null) : null
    )
    React.useEffect(() => {
      if (!userId) return
      this.fetchInstalledApps(userId)
        .then(setApps)
        .catch(() => {})
    }, [userId])
    return apps
  }

  private appProfileHref(appId: string): string {
    return `slack://app?id=${appId}&tab=more_info`
  }

  private InstalledAppsBlock = (props: { userId?: string }) => {
    const apps = this.useInstalledApps(props.userId)
    if (!apps || apps.length === 0) return null

    return (
      <div className="taut-installed-apps">
        <div className="taut-installed-apps__heading">
          Installed apps ({apps.length})
        </div>
        <div className="taut-installed-apps__grid">
          {apps.map((app) => {
            const icon = iconOf(app.icons)
            const isOfficial = app.is_app_directory_approved || app.is_certified
            return (
              <a
                key={app.id}
                className={`taut-installed-apps__item ${isOfficial ? 'taut-installed-apps__item-official' : 'taut-installed-apps__item-internal'}`}
                href={this.appProfileHref(app.id)}
                title={app.description || app.name}
                rel="noreferrer"
              >
                {icon ? (
                  <img
                    className="taut-installed-apps__icon"
                    src={icon}
                    alt=""
                  />
                ) : (
                  <span className="taut-installed-apps__icon taut-installed-apps__icon--placeholder" />
                )}
                <span className="taut-installed-apps__name">{app.name}</span>
              </a>
            )
          })}
        </div>
      </div>
    )
  }

  // --- who installed an app ------------------------------------------------

  /** fetch the app's marketplace page and pull out the data-automount blocks */
  private async fetchAppPage(appId: string): Promise<AppPageData | null> {
    // we fetch the app's marketplace page and parse it with the DOMParser,
    // then we extract the data-automount blocks that contain the app's infos
    // (I couldn't find an API for this, but it works)
    try {
      const res = await this.api.fetch(`${MARKETPLACE_BASE}/${appId}`, {
        credentials: 'include',
        signal: this.api.signal,
      })
      if (!res.ok) return null
      const html = await res.text()

      // Parsed offline via DOMParser: this document is never attached to
      // the page, never rendered, and DOMParser documents don't execute
      // <script> tags or fetch subresources
      const doc = new DOMParser().parseFromString(html, 'text/html')

      // helper function
      const read = <T,>(name: string): T | undefined => {
        const el = doc.querySelector(`[data-automount-component="${name}"]`)
        // the parser already decodes HTML entities in attribute values,
        // so this is plain JSON text at this point
        const raw = el?.getAttribute('data-automount-props')
        if (!raw) return undefined
        try {
          return JSON.parse(raw) as T
        } catch {
          return undefined
        }
      }

      // there are three data-automount blocks on the page that are interesting for use,
      // AppDirectoryFeatures contains some app detailes
      // AppDirectoryAuthorizations contains the icons and the authorizations
      // AppDirectoryBotUser contains the memberships (e.g., channel it joined)
      return {
        features: read<AppDirectoryFeatures>('AppDirectoryFeatures'),
        authorizations: read<AppDirectoryAuthorizations>(
          'AppDirectoryAuthorizations'
        ),
        botUser: read<AppDirectoryBotUser>('AppDirectoryBotUser'),
      }
    } catch (err) {
      this.log('fetchAppPage failed', err)
      return null
    }
  }

  private async fetchAppData(appId: string): Promise<AppPageData | null> {
    return this.appPageCache.fetch(appId, () => this.fetchAppPage(appId))
  }

  private useAppData(appId: string | undefined) {
    const [data, setData] = React.useState<AppPageData | null>(() =>
      appId ? (this.appPageCache.get(appId) ?? null) : null
    )
    React.useEffect(() => {
      if (!appId) return
      this.fetchAppData(appId)
        .then(setData)
        .catch(() => {})
    }, [appId])
    return data
  }

  /** one avatar + name row for a single authorized user */
  private InstallerRow = (props: { userId: string; fallbackName: string }) => {
    const user = this.api.members.useMember(props.userId)

    const name =
      user?.profile?.display_name ||
      user?.profile?.real_name ||
      user?.real_name ||
      user?.name ||
      props.fallbackName

    const avatar = user?.profile?.image_48

    return (
      <div className="taut-app-installers__row">
        {avatar ? (
          <img className="taut-app-installers__avatar" src={avatar} alt="" />
        ) : (
          <span className="taut-app-installers__avatar taut-app-installers__avatar--placeholder" />
        )}
        <this.api.elements.MrkdwnElement text={`<@${props.userId}>`} />
        <span className="taut-app-installers__name">{name}</span>
      </div>
    )
  }

  private ChannelMentions = (props: { channelIds: string[] }) => {
    const Mrkdwn = this.api.elements.MrkdwnElement
    if (!Mrkdwn) return <>{props.channelIds.join(', ')}</>

    const text = props.channelIds.map((id) => `<#${id}>`).join('  ')
    return <Mrkdwn text={text} />
  }

  private AppInstallersBlock = (props: {
    appId?: string
    app_about_screen?: boolean
  }) => {
    const data = this.useAppData(props.appId)
    const auths = data?.authorizations?.authorizations
    const memberships = data?.botUser?.memberships

    if (!auths || auths.length === 0) return null

    return (
      <div
        className={`p-app_space_profile__section taut-app-installers taut-app-installers-app`}
      >
        <div className="taut-app-installers__heading">
          Installed / authorized by ({auths.length})
        </div>
        <div className="taut-app-installers__list">
          {auths.map((auth) => (
            <this.InstallerRow
              key={auth.encodedUserLink}
              userId={auth.encodedUserLink}
              fallbackName={auth.userDisplayName}
            />
          ))}
        </div>
        {memberships && memberships.length > 0 ? (
          <div
            className={`taut-app-installers__memberships${props.app_about_screen ? ' taut-app-installers__memberships--about-screen' : ''}`}
          >
            <div className="taut-app-installers__memberships-label">
              In {memberships.length} channel
              {memberships.length === 1 ? '' : 's'}
              {data?.botUser?.otherGroups
                ? ` (+${data.botUser.otherGroups} more you can't see)`
                : ''}
              :
            </div>
            <this.ChannelMentions channelIds={memberships} />
          </div>
        ) : null}
      </div>
    )
  }

  private injectStyles() {
    this.api.setStyle(`
      .taut-installed-apps, .taut-app-installers {
        padding: 10px 0px;
        border-top: 1px solid rgba(var(--sk_foreground_low, #1d1c1d), .13);
      }
      .taut-app-installers-app {
        padding: 10px 20px;
      }
      .taut-installed-apps__heading, .taut-app-installers__heading {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        opacity: 0.6;
        margin-bottom: 8px;
      }
      .taut-installed-apps__grid {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .taut-installed-apps__item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 6px;
        background: rgba(134, 134, 134, 0.09);
        color: inherit;
        text-decoration: none;
        font-size: 12px;
        max-width: 160px;
      }
      .taut-installed-apps__item-official {
        background: rgba(0, 122, 90, 0.10);
      }
      .taut-installed-apps__item-internal {
        background: rgba(134, 134, 134, 0.09);
      }
      .taut-installed-apps__item:hover {
        background: rgba(134, 134, 134, 0.16);
      }
      .taut-installed-apps__item-official:hover {
        background: rgba(0, 122, 90, 0.16);
      }
      .taut-installed-apps__icon {
        width: 16px;
        height: 16px;
        border-radius: 4px;
        flex-shrink: 0;
      }
      .taut-installed-apps__icon--placeholder {
        background: rgba(134, 134, 134, 0.3);
      }
      .taut-installed-apps__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .taut-app-installers__list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 260px;
        overflow-y: auto;
      }
      .taut-app-installers__row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
      }
      .taut-app-installers__avatar {
        width: 24px;
        height: 24px;
        border-radius: 6px;
        flex-shrink: 0;
        object-fit: cover;
      }
      .taut-app-installers__avatar--placeholder {
        background: rgba(134, 134, 134, 0.3);
      }
      .taut-app-installers__memberships {
        margin-top: 10px;
        font-size: 12px;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .taut-app-installers__memberships--about-screen {
        max-height: clamp(100px, 30vh, 400px);
        overflow-y: auto;
        overscroll-behavior: contain;
        padding-right: 4px;
      }
      .taut-app-installers__memberships-label {
        opacity: 0.7;
        margin-bottom: 4px;
      }
      .taut-installed-apps__token-prompt {
        max-width: 420px;
        font-size: 13px;
        line-height: 1.5;
      }
      .taut-installed-apps__token-prompt p {
        margin: 0 0 12px;
      }
      .taut-installed-apps__token-input {
        width: 100%;
        box-sizing: border-box;
        padding: 8px;
        border-radius: 6px;
        border: 1px solid rgba(134, 134, 134, 0.35);
        font-family: monospace;
        font-size: 12px;
        resize: vertical;
      }
      .taut-installed-apps__token-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }
      .taut-installed-apps__token-btn {
        border: 0;
        border-radius: 6px;
        padding: 7px 14px;
        font-size: 13px;
        cursor: pointer;
      }
      .taut-installed-apps__token-btn--secondary {
        background: rgba(134, 134, 134, 0.14);
        color: inherit;
      }
      .taut-installed-apps__token-btn--primary {
        background: #007a5a;
        color: white;
      }
      .taut-installed-apps__token-btn--primary:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .taut-about-scroll-wrapper {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        height: 100%;
        min-height: 0;
        width: 100%;
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      .taut-about-scroll-wrapper__original,
      .taut-about-scroll-wrapper > .taut-app-installers {
        flex: 0 0 auto;
      }
    `)
  }
}
