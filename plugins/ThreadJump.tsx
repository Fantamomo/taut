// Jump to the top, bottom, a date, or 100 replies at a time in long threads

import { opt, TautPlugin, type ThreadPane } from '$taut'

type Reply = { ts: string }

const MIN_REPLIES = 50

const day = (ts: string) => {
  const d = new Date(Number(ts) * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default class ThreadJump extends TautPlugin<typeof ThreadJump> {
  static readonly id = 'ThreadJump'
  static readonly pluginName = 'Thread Jump'
  static readonly description =
    'Jump to the top, bottom, a date, or 100 replies at a time in long threads'
  static readonly authors = ['jeremy'] as const
  static readonly category = 'messages'
  static readonly defaultConfig = {
    enabled: false,
    step: opt.number(100, 'Replies to move each step', { min: 1, max: 1000 }),
    banners: opt(
      true,
      'Show Slack\'s unreleased "Back to top" and "Latest messages" banners in threads'
    ),
    findInThread: opt(
      true,
      'Show Slack\'s unreleased "Search in thread" button'
    ),
  }

  private get step() {
    return Math.min(1000, Math.max(1, Math.round(this.config.step) || 100))
  }

  start(): void {
    if (this.config.banners)
      this.api.experiments.set('fe_long_threads_jump_to_latest', 'on')
    if (this.config.findInThread)
      this.api.experiments.set('find_in_thread', 'on')

    this.api.patchComponent('ThreadSearchButton', (Original) => (props) => (
      <>
        <this.JumpButton />
        <Original {...props} />
      </>
    ))

    this.api.setStyle(`
      .taut-jump-panel {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        width: 300px;
      }
      .taut-jump-panel__date {
        grid-column: 1 / -1;
      }
      .taut-jump-panel__date > .c-button {
        width: 100%;
      }
    `)
  }

  private JumpButton = () => {
    const { Tooltip, SvgIcon, Popover } = this.api.elements
    const [anchor, setAnchor] = React.useState<DOMRect | null>(null)
    const [windowRef] = React.useState(() => new WeakRef(window))
    const pane = this.api.threads.usePane()
    const root = this.api.redux.useReduxState(
      (state) => pane && state.messages?.[pane.channelId]?.[pane.threadTs]
    )
    if (!pane || !root?.latest_reply || (root.reply_count ?? 0) < MIN_REPLIES)
      return null

    return (
      <>
        <Tooltip tip="Jump in thread" position="bottom" delay={300}>
          <button
            type="button"
            className="c-button-unstyled c-icon_button c-icon_button--size_medium c-icon_button--default p-flexpane_header__control"
            aria-label="Jump in thread"
            aria-haspopup="dialog"
            aria-expanded={!!anchor}
            onClick={(e) =>
              setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())
            }
          >
            <SvgIcon name="caret-up-down" size={20} />
          </button>
        </Tooltip>
        {anchor && (
          <Popover
            isOpen
            targetBounds={anchor}
            windowRef={windowRef}
            position="bottom-right"
            offsetY={4}
            onClose={() => setAnchor(null)}
            ariaRole="dialog"
            ariaLabel="Jump in thread"
          >
            <this.Panel
              pane={pane}
              latestReply={root.latest_reply}
              close={() => setAnchor(null)}
            />
          </Popover>
        )}
      </>
    )
  }

  private Panel = ({
    pane,
    latestReply,
    close,
  }: {
    pane: ThreadPane
    latestReply: string
    close: () => void
  }) => {
    const { Button, DatePickerTrigger, SvgIcon } = this.api.elements
    const [busy, setBusy] = React.useState(false)
    // closing the panel cancels a lookup that hasn't jumped yet
    const [lookup] = React.useState(() => new AbortController())
    React.useEffect(() => () => lookup.abort(), [lookup])
    const { channelId, threadTs } = pane
    const step = this.step

    const replies = async (params: Record<string, string>) => {
      const res = await this.api.userAPI<{ messages?: Reply[] }>(
        'conversations.replies',
        { channel: channelId, ts: threadTs, ...params },
        { signal: AbortSignal.any([this.api.signal, lookup.signal]) }
      )
      return (res.messages ?? []).filter((m) => m.ts !== threadTs)
    }

    const run = (find: () => Promise<string | undefined>, closes?: boolean) => {
      setBusy(true)
      find()
        .then((ts) => {
          if (!ts || lookup.signal.aborted) return
          pane.jumpToReply(ts)
          if (closes) close()
        })
        .catch((error) => {
          if (!lookup.signal.aborted) this.log('Jump failed', error)
        })
        .finally(() => setBusy(false))
    }

    // the reply `by` number of replies from `base` (when the pane's loaded replies have it)
    const fromLoaded = (base: string, by: number) => {
      const loaded = pane.loaded()
      const at = loaded.indexOf(base)
      if (at < 0) return undefined
      if (at + by < 0) return loaded[0] === threadTs ? threadTs : undefined
      if (at + by >= loaded.length)
        return loaded.at(-1) === latestReply ? latestReply : undefined
      return loaded[at + by]
    }

    const back = () =>
      run(async () => {
        const base = pane.topReply()
        if (!base || base === threadTs) return threadTs
        const loaded = fromLoaded(base, -step)
        if (loaded) return loaded
        const before = await replies({ latest: base, limit: String(step) })
        return before.length < step ? threadTs : before[before.length - step].ts
      })

    const ahead = () =>
      run(async () => {
        const base = pane.topReply()
        if (!base) return latestReply
        const loaded = fromLoaded(base, step)
        if (loaded) return loaded
        const after = await replies({ oldest: base, limit: String(step) })
        return after[step - 1]?.ts ?? latestReply
      })

    const toDate = (date: string) =>
      run(async () => {
        const [y, m, d] = date.split('-').map(Number)
        const oldest = new Date(y, m - 1, d).getTime() / 1000
        const loaded = pane.loaded()
        const at = loaded.findIndex((ts) => Number(ts) >= oldest)
        if (at > 0) return loaded[at]
        if (at === 0 && loaded[0] === threadTs && loaded[1]) return loaded[1]
        if (at < 0 && loaded.at(-1) === latestReply) return latestReply
        const [first] = await replies({ oldest: String(oldest), limit: '1' })
        return first?.ts ?? latestReply
      }, true)

    const to = (ts: string) => {
      close()
      pane.jumpToReply(ts)
    }

    return (
      <div className="c-date_picker__dropdown taut-jump-panel">
        <Button
          type="outline"
          size="small"
          disabled={busy}
          onClick={() => to(threadTs)}
        >
          Top
        </Button>
        <Button
          type="outline"
          size="small"
          disabled={busy}
          onClick={() => to(latestReply)}
        >
          Bottom
        </Button>
        <Button
          type="outline"
          size="small"
          disabled={busy}
          aria-label={`${step} replies back`}
          onClick={back}
        >
          {`-${step}`}
        </Button>
        <Button
          type="outline"
          size="small"
          disabled={busy}
          aria-label={`${step} replies ahead`}
          onClick={ahead}
        >
          {`+${step}`}
        </Button>
        <div className="taut-jump-panel__date">
          <DatePickerTrigger
            disableDatesBefore={day(threadTs)}
            disableDatesAfter={day(latestReply)}
            onDateChange={toDate}
          >
            <Button type="outline" size="small" disabled={busy}>
              <span className="margin_right_50">
                <SvgIcon name="calendar" size={20} />
              </span>
              Jump to date
            </Button>
          </DatePickerTrigger>
        </div>
      </div>
    )
  }
}
