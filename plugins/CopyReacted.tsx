// Copy the list of people who reacted to a message

import { type MenuTemplateItem, opt, TautPlugin } from '$taut'

type SlackReaction = { name?: string; users?: string[]; count: number }
type ReactionBarProps = { reactionKey?: string; reactions?: SlackReaction[] }
type Reactions = { reactionKey?: string; reactions: SlackReaction[] }

const REACTION_KEY_RE = /^message-(\d+\.\d+)-([A-Z0-9]+)$/

// stable identity, so context consumers don't rerender
const NO_REACTIONS: Reactions = { reactions: [] }

const isPartial = (reaction: SlackReaction) =>
  reaction.count > (reaction.users?.length ?? 0)

export default class CopyReacted extends TautPlugin<typeof CopyReacted> {
  static readonly id = 'CopyReacted'
  static readonly pluginName = 'Copy Reacted'
  static readonly description =
    'Copy the list of people who reacted to a message'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'messages'
  static readonly defaultConfig = {
    enabled: false,
    format: opt.select(
      [
        { value: 'mentions', label: 'Mentions (<@U123>)' },
        { value: 'names', label: 'Display names' },
        { value: 'handles', label: 'Handles (@username)' },
      ],
      'mentions',
      'How each person is written'
    ),
    separator: opt.select(
      [
        { value: 'space', label: 'Spaces' },
        { value: 'newline', label: 'New lines' },
        { value: 'comma', label: 'Commas' },
      ],
      'space',
      'What goes between people'
    ),
  }

  private readonly ReactionsContext =
    React.createContext<Reactions>(NO_REACTIONS)

  private async reactorName(userId: string): Promise<string> {
    const member = await this.api.members.getMember(userId)
    return (
      member?.profile?.display_name ||
      member?.profile?.real_name ||
      member?.real_name ||
      userId
    )
  }

  private async reactorHandle(userId: string): Promise<string> {
    const member = await this.api.members.getMember(userId)
    return `@${member?.name || userId}`
  }

  /** everyone who reacted with `reactions`, fetched if needed */
  private async reactorIds({
    reactionKey,
    reactions,
  }: Reactions): Promise<string[]> {
    if (reactions.some(isPartial)) {
      const [, timestamp, channel] =
        REACTION_KEY_RE.exec(reactionKey ?? '') ?? []
      if (!timestamp || !channel)
        throw new Error(`no message for ${reactionKey}`)
      const res = await this.api.within(
        (signal) =>
          this.api.userAPI<{ message?: { reactions?: SlackReaction[] } }>(
            'reactions.get',
            { channel, timestamp, full: 'true' },
            { signal }
          ),
        10_000
      )
      if (!res) throw new Error('reactions.get timed out')
      const names = new Set(reactions.map((r) => r.name))
      reactions = (res.message?.reactions ?? []).filter((r) =>
        names.has(r.name)
      )
    }
    return [...new Set(reactions.flatMap((r) => r.users ?? []))]
  }

  private async copyReactors(target: Reactions): Promise<void> {
    let reactors: string[]
    try {
      reactors = await this.reactorIds(target)
    } catch (err) {
      if (this.api.signal.aborted) return
      this.log('could not load reactors', err)
      this.api.modal.alert({
        title: 'Could not copy',
        body: 'Could not load everyone who reacted.',
      })
      return
    }
    if (!reactors.length) return
    const separator = { space: ' ', newline: '\n', comma: ', ' }[
      this.config.separator
    ]
    const { format } = this.config
    const lines =
      format === 'names'
        ? await Promise.all(reactors.map((id) => this.reactorName(id)))
        : format === 'handles'
          ? await Promise.all(reactors.map((id) => this.reactorHandle(id)))
          : reactors.map((id) => `<@${id}>`)
    try {
      await navigator.clipboard.writeText(lines.join(separator))
    } catch (err) {
      this.log('could not copy reactors', err)
      this.api.modal.alert({
        title: 'Could not copy',
        body: 'Slack denied access to the clipboard.',
      })
    }
  }

  private readonly CopyButton = () => {
    const { reactionKey, reactions } = React.useContext(this.ReactionsContext)
    if (!reactions.length) return null

    const { Menu } = this.api.menu
    const { SvgIcon, MrkdwnElement } = this.api.elements

    const known = new Set(reactions.flatMap((r) => r.users ?? [])).size
    const everyone = reactions.some(isPartial)
      ? `${Math.max(known, ...reactions.map((r) => r.count))}+`
      : known
    const template: MenuTemplateItem[] = [
      {
        key: 'taut-copy-reacted__everyone',
        label: `Everyone (${everyone})`,
        click: () => this.copyReactors({ reactionKey, reactions }),
      },
    ]
    if (reactions.length > 1) {
      for (const reaction of reactions) {
        template.push({
          key: `taut-copy-reacted__${reaction.name}`,
          // mrkdwn renders the emoji as an image
          label: (
            <MrkdwnElement text={`:${reaction.name}: (${reaction.count})`} />
          ),
          click: () =>
            this.copyReactors({ reactionKey, reactions: [reaction] }),
        })
      }
    }

    return (
      <Menu template={template} position="bottom">
        <button
          type="button"
          className="c-button-unstyled c-reaction_add taut-copy-reacted"
          data-qa="taut_copy_reacted"
          aria-label="Copy who reacted"
        >
          <SvgIcon name="copy" size={18} />
        </button>
      </Menu>
    )
  }

  start() {
    this.api.setStyle(
      `
        /* mirrors how .c-reaction_add__fg greys the add-reaction icon */
        .taut-copy-reacted {
          color: var(--dt_color-content-pry);
        }

        .sk-client-theme--dark .taut-copy-reacted {
          color: var(--dt_color-content-ter);
        }

        .sk-client-theme--dark .taut-copy-reacted:is(:hover, :focus) {
          color: var(--dt_color-content-pry);
        }
      `
    )

    this.api.patchComponent<ReactionBarProps>(
      'ReactionBar',
      (Original) => (props) => {
        const { reactionKey, reactions } = props
        const value = React.useMemo(
          () => (reactions ? { reactionKey, reactions } : NO_REACTIONS),
          [reactionKey, reactions]
        )
        return (
          <this.ReactionsContext.Provider value={value}>
            <Original {...props} />
          </this.ReactionsContext.Provider>
        )
      }
    )

    // last child inside the bar, so the chip stays in the row
    this.api.patchComponent('ReactionAddButton', (Original) => (props) => (
      <>
        <Original {...props} />
        <this.CopyButton />
      </>
    ))

    this.log('Started')
  }
}
