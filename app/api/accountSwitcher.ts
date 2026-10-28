import type { TautCookie } from '../../shared/TautBridge'
import type { NormalizedBridge } from '../bridgeCompat'
import {
  getActiveTeam,
  getActiveTeamId,
  type LocalConfigTeam,
  readLocalConfig,
} from '../slack/localConfig'

const SLACK_URL = 'https://app.slack.com'
export const SECRET_KEY = 'accounts'

export type StoredAccount = {
  userId: string
  teamId: string
  // the whole entry, enterprise boot needs `url` (the API host) or fails with `api_missing_host_error`
  team: LocalConfigTeam
  // the `d` cookie, the server rejects the team's xoxc token without it
  xoxd: string
  updatedAt: number
}

/** call at the very top of bootstrap(), before any await and before Slack's webpack reads `localConfig_v2` */
export function applyPendingSwitch(): void {
  let pendingJson: string | null
  try {
    // the account handed over by `switchTo` for this page load
    pendingJson = localStorage.getItem('taut:pendingSwitch')
  } catch {
    return
  }
  if (!pendingJson) return
  localStorage.removeItem('taut:pendingSwitch')

  let account: StoredAccount
  try {
    account = JSON.parse(pendingJson)
  } catch {
    return
  }
  if (!account.team?.token) return

  const localConfig = readLocalConfig()
  localConfig.teams ??= {}
  localConfig.teams[account.teamId] = {
    ...localConfig.teams[account.teamId],
    ...account.team,
  }
  localConfig.lastActiveTeamId = account.teamId
  localConfig.orderedTeamIds ??= []
  if (!localConfig.orderedTeamIds.includes(account.teamId))
    localConfig.orderedTeamIds.push(account.teamId)
  localStorage.setItem('localConfig_v2', JSON.stringify(localConfig))
  console.log(`[Taut] Applied pending account switch to ${account.userId}`)
}

export class AccountSwitcher {
  /** whether this loader can write the HttpOnly `d` cookie, which switching needs */
  readonly supported: boolean
  private readonly cookies: NormalizedBridge['cookies']

  constructor(private bridge: NormalizedBridge) {
    this.cookies = bridge.cookies ?? null
    this.supported = this.cookies != null
  }

  /** throws when the saved accounts can't be read, so nothing writes over them */
  private async load(): Promise<Record<string, StoredAccount>> {
    let accounts: unknown
    try {
      accounts = JSON.parse((await this.bridge.readSecret(SECRET_KEY)) || '{}')
    } catch (cause) {
      throw new Error('Saved accounts are unreadable', { cause })
    }
    if (!accounts || typeof accounts !== 'object')
      throw new Error('Saved accounts are unreadable')
    return accounts as Record<string, StoredAccount>
  }

  /** applies `edit` to the saved accounts under a lock shared with other tabs */
  private async change(
    edit: (accounts: Record<string, StoredAccount>) => void
  ): Promise<void> {
    await navigator.locks.request(`taut:secret:${SECRET_KEY}`, async () => {
      const accounts = await this.load()
      edit(accounts)
      const json = JSON.stringify(accounts)
      if (!(await this.bridge.writeSecret(SECRET_KEY, json)))
        throw new Error('Failed to save accounts')
    })
  }

  async list(): Promise<StoredAccount[]> {
    return Object.values(await this.load())
  }

  /** removes a saved account without touching the live session */
  async forget(userId: string): Promise<void> {
    await this.change((accounts) => {
      delete accounts[userId]
    })
  }

  /** drops saved accounts that fail auth.test, ones that can't be checked are in neither list */
  async validate(): Promise<{ kept: string[]; dropped: string[] }> {
    const checks = await Promise.all(
      Object.values(await this.load()).map(async (account) => ({
        account,
        status: await this.checkAuth(account),
      }))
    )
    const dropped = checks.filter((c) => c.status === 'invalid')
    if (dropped.length) {
      await this.change((accounts) => {
        for (const { account } of dropped) {
          // unless a capture saved a new session since the check
          if (accounts[account.userId]?.xoxd === account.xoxd)
            delete accounts[account.userId]
        }
      })
    }
    return {
      kept: checks
        .filter((c) => c.status === 'valid')
        .map((c) => c.account.userId),
      dropped: dropped.map((c) => c.account.userId),
    }
  }

  private async checkAuth(
    account: StoredAccount
  ): Promise<'valid' | 'invalid' | 'unknown'> {
    if (!account.team?.url || !account.team?.token || !account.xoxd)
      return 'invalid'
    try {
      const url = new URL('api/auth.test', account.team.url).href
      const res = await this.bridge.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // backend makes sure this _replaces_ the cookie jar
          Cookie: `d=${account.xoxd}`,
        },
        body: `token=${encodeURIComponent(account.team.token)}`,
      })
      const json = await res.json()
      return json?.ok === true ? 'valid' : 'invalid'
    } catch {
      return 'unknown'
    }
  }

  async captureCurrent(): Promise<StoredAccount | null> {
    if (!this.supported || !this.cookies) return null
    const localConfig = readLocalConfig()
    const teamId = getActiveTeamId(localConfig)
    const team = getActiveTeam(localConfig)
    if (!teamId || !team?.token || !team.user_id) return null

    const sessionCookie = await this.cookies.get({ url: SLACK_URL, name: 'd' })
    if (!sessionCookie?.value) return null

    const account: StoredAccount = {
      userId: team.user_id,
      teamId,
      team: { ...team },
      xoxd: sessionCookie.value,
      updatedAt: Date.now(),
    }
    await this.change((accounts) => {
      accounts[account.userId] = account
    })
    return account
  }

  /** checks the saved session with auth.test first, and throws without touching the live session if it fails */
  async switchTo(userId: string): Promise<void> {
    if (!this.supported || !this.cookies)
      throw new Error('Account switching is not supported by this loader')
    const account = (await this.load())[userId]
    if (!account?.team?.token)
      throw new Error(`No usable saved account for ${userId}`)

    const status = await this.checkAuth(account)
    if (status === 'invalid')
      throw new Error('That account is signed out, add it again')
    if (status === 'unknown')
      throw new Error("Couldn't reach Slack to check that account")

    await this.captureCurrent()

    const cookie: TautCookie & { url: string } = {
      url: SLACK_URL,
      name: 'd',
      value: account.xoxd,
      domain: '.slack.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
    }
    const ok = await this.cookies.set(cookie)
    if (!ok) throw new Error('Failed to set session cookie')

    // Slack's unload flush rewrites `localConfig_v2` from redux, so the next boot writes the team entry
    localStorage.setItem('taut:pendingSwitch', JSON.stringify(account))
    location.assign(`${SLACK_URL}/client/${account.teamId}`)
  }

  /** saves the current account, removes it from this browser and reloads to Slack's login */
  async addAccount(): Promise<void> {
    if (!this.supported || !this.cookies)
      throw new Error('Account switching is not supported by this loader')

    const saved = await this.captureCurrent()
    const localConfig = readLocalConfig()
    const teamId = getActiveTeamId(localConfig)
    const domain = saved?.team.domain ?? getActiveTeam(localConfig)?.domain

    // Slack's per-session cookies, all must go for a new account to log in
    for (const name of ['d', 'd-s', 'uc']) {
      await this.cookies.remove({ url: SLACK_URL, name })
    }

    if (teamId && localConfig.teams?.[teamId]) {
      delete localConfig.teams[teamId]
      localConfig.orderedTeamIds = (localConfig.orderedTeamIds ?? []).filter(
        (id) => id !== teamId
      )
      delete localConfig.lastActiveTeamId
      localStorage.setItem('localConfig_v2', JSON.stringify(localConfig))
    }

    // TODO: improve login (desktop in-app login? automatically sign out HCA?)
    if (domain === 'hackclub') {
      const url = 'https://auth.hackclub.com'
      if (this.bridge.loader === 'electron') {
        window.open(url, '_blank')
        location.reload()
      } else {
        location.assign(url)
      }
    } else {
      location.assign(domain ? `https://${domain}.slack.com` : SLACK_URL)
    }
  }
}
