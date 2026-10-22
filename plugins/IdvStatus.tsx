// Shows a red squiggle on users who are not IDV eligible, and orange when verified ID but >18

import { opt, TautPlugin } from '$taut'

type IdvStatusType = 'eligible' | 'over_18' | 'unverified' | 'loading'

export default class IdvStatus extends TautPlugin<typeof IdvStatus> {
  static readonly id = 'IdvStatus'
  static readonly pluginName = 'IDV Status'
  static readonly description =
    'Shows a red squiggle on users who are not IDV eligible, and orange when verified ID but >18'
  static readonly authors = ['sahil', 'rowan'] as const
  static readonly category = 'people'
  static readonly hackClubOnly = true
  static readonly defaultConfig = {
    enabled: false,
    unverifiedColor: opt.color(
      '#e01e5a',
      'Squiggle for users who are not verified, any CSS color'
    ),
    over18Color: opt.color(
      '#d97706',
      'Squiggle for users verified as over 18',
      { label: 'Over 18 color' }
    ),
  }

  /** eligible and over 18 results */
  private verified = new this.api.Cache<IdvStatusType>('idv_verified', {
    ttl: 24 * 60 * 60 * 1000,
    maxSize: 5000,
  })
  /** every result, (unverified isn't kept very long, so when someone verifies it shows up quickly) */
  private recent = new this.api.Cache<IdvStatusType>('idv_recent', {
    ttl: 10 * 60 * 1000,
    maxSize: 5000,
  })

  async start() {
    await Promise.all([this.verified.load(), this.recent.load()])
    if (this.api.signal.aborted) return

    this.api.patchComponent<{
      botId?: string
      userId?: string
      className?: string
    }>('BaseMessageSender', (OriginalBaseMessageSender) => (props) => {
      const userId = props.userId
      const isBotMessage = !!props.botId

      const [idvStatus, setIdvStatus] = React.useState<IdvStatusType | null>(
        () => {
          if (!userId || isBotMessage) return null
          if (!userId.startsWith('U') && !userId.startsWith('W')) return null
          if (userId === 'USLACKBOT') return null
          return this.cachedIdvStatus(userId) ?? 'loading'
        }
      )

      React.useEffect(() => {
        if (!userId || isBotMessage || idvStatus === null) return
        if (!userId.startsWith('U') && !userId.startsWith('W')) return
        if (userId === 'USLACKBOT') return

        this.fetchIdvStatus(userId)
          .then(setIdvStatus)
          .catch(() => {})
      }, [userId, isBotMessage])

      const className =
        idvStatus === 'unverified'
          ? 'taut-idv-status--not-eligible'
          : idvStatus === 'over_18'
            ? 'taut-idv-status--over-18'
            : ''

      return (
        <OriginalBaseMessageSender
          {...props}
          className={
            props.className ? `${props.className} ${className}` : className
          }
        />
      )
    })

    const { unverifiedColor: unverified, over18Color: over18 } = this.config
    this.api.setStyle(
      `
        .taut-idv-status--not-eligible, .taut-idv-status--not-eligible .c-message__sender_button {
          text-decoration: underline wavy ${unverified} !important;
          text-decoration-thickness: 1px !important;
        }

        .taut-idv-status--over-18, .taut-idv-status--over-18 .c-message__sender_button {
          text-decoration: underline wavy ${over18} !important;
          text-decoration-thickness: 1px !important;
        }
      `
    )
  }

  cachedIdvStatus(userId: string): IdvStatusType | undefined {
    return this.verified.get(userId) ?? this.recent.get(userId)
  }

  async fetchIdvStatus(userId: string): Promise<IdvStatusType> {
    const cached = this.cachedIdvStatus(userId)
    if (cached) return cached
    const status = await this.recent.fetch(userId, async () => {
      const url = new URL('https://identity.hackclub.com/api/external/check')
      url.searchParams.set('slack_id', userId)
      const response = await fetch(url, { signal: this.api.signal })
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`)
      const data = await response.json()

      if (data.result === 'verified_eligible') return 'eligible'
      if (data.result === 'verified_but_over_18') return 'over_18'
      return 'unverified'
    })
    if (status !== 'unverified') this.verified.set(userId, status)
    return status
  }
}
