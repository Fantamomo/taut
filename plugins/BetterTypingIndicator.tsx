// Shows as many typing people as possible and lets you view their profiles

import { type componentReplacer, TautPlugin } from '$taut'

type TypingRecord = {
  channelId?: string | null
  threadTs?: string | null
  memberId?: string | null
  memberIsSelf?: boolean | null
}
type Conversation = { channelId?: string; threadTs?: string }
type TypingNamesProps = {
  firstTyper?: React.ReactNode
  secondTyper?: React.ReactNode
  severalPeopleAreTyping?: boolean
}
type MemberLinkProps = {
  id: string
  className?: string
  children?: React.ReactNode
}
type NameOf = (state: unknown, member: unknown) => string
type I18nClass = new (
  namespace: string
) => { t: (text: string, values?: Record<string, unknown>) => string }
type Phrases = {
  /** the text around one name */
  one: string[]
  /** the text around two names */
  two: string[]
  others: (count: number) => string
}
type Typer = { id: string; name: string }
type Box = {
  width: number
  /** the hidden sample's width, so a font change makes a new box */
  sample: number
  fontFamily: string
  fontSize: string
  letterSpacing: string
  regularWeight: string
  boldWeight: string
}

/** names cut to fit keep at least this many ems */
const NAME_MIN_EMS = 8
/** a one-word name up to this many ems is never cut */
const WORD_MAX_EMS = 12

export default class BetterTypingIndicator extends TautPlugin<
  typeof BetterTypingIndicator
> {
  static readonly id = 'BetterTypingIndicator'
  static readonly pluginName = 'Better Typing Indicator'
  static readonly description =
    'Shows as many typing people as possible and lets you view their profiles'
  static readonly authors = ['jeremy'] as const
  static readonly category = 'messageBox'
  static readonly defaultConfig = {
    enabled: true,
  }

  /** the conversation whose typers the indicator below shows */
  private readonly ConversationContext =
    React.createContext<Conversation | null>(null)
  /** holds Slack's `getPrefCompliantMemberName` once it loads */
  private readonly nameOf = new this.api.Store<NameOf | undefined>(undefined)
  /** holds Slack's translated sentences once its `I18n` loads */
  private readonly phrases = new this.api.Store<Phrases | undefined>(undefined)
  private canvas?: OffscreenCanvasRenderingContext2D
  private readonly textWidths = new Map<string, number>()
  private readonly graphemes = new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  })

  private textWidth(text: string, font: string, letterSpacing: string): number {
    const key = `${font}\n${letterSpacing}\n${text}`
    let width = this.textWidths.get(key)
    if (width === undefined) {
      this.canvas ??= new OffscreenCanvas(0, 0).getContext('2d') ?? undefined
      if (!this.canvas) return 0
      this.canvas.font = font
      // canvas ignores normal and would keep the last spacing
      this.canvas.letterSpacing =
        letterSpacing === 'normal' ? '0px' : letterSpacing
      width = this.canvas.measureText(text).width
      // a font still loading measures as its fallback
      if (!document.fonts.check(font)) return width
      const [oldest] = this.textWidths.keys()
      if (this.textWidths.size >= 1000 && oldest) this.textWidths.delete(oldest)
      this.textWidths.set(key, width)
    }
    return width
  }

  start(): void {
    const MemberLink = this.api.lazyComponent<MemberLinkProps>('MemberLink')
    const { Tooltip } = this.api.elements

    this.api
      .waitForExport<NameOf>(this.api.byName('getPrefCompliantMemberName'))
      .then(this.nameOf.set)
    this.api
      .waitForExport<I18nClass>(this.api.byName('I18n'))
      .then((I18n) => this.phrases.set(phrasesFrom(I18n)))

    this.api.setStyle(`
      .taut-typing-indicator {
        display: block;
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .taut-typing-indicator__sample {
        position: absolute;
        visibility: hidden;
        pointer-events: none;
      }
      .taut-typing-indicator__member {
        color: inherit;
        letter-spacing: inherit;
      }
    `)

    const provide: componentReplacer<Conversation> = (Original) => (props) => {
      const { channelId, threadTs } = props
      const value = React.useMemo(
        () => ({ channelId, threadTs }),
        [channelId, threadTs]
      )
      return (
        <this.ConversationContext.Provider value={value}>
          <Original {...props} />
        </this.ConversationContext.Provider>
      )
    }
    this.api.patchComponent<Conversation>('MessagePaneInput', provide)
    this.api.patchComponent<Conversation>('ThreadTypingIndicator', provide)

    this.api.patchComponent<TypingNamesProps>(
      'TypingNames',
      (Original) => (props) => {
        const conversation = React.useContext(this.ConversationContext)
        const nameOf = this.nameOf.use()
        const phrases = this.phrases.use()
        // a string, so it's equal when nothing changed
        const json = this.api.redux.useReduxState((state) => {
          if (!conversation?.channelId || !nameOf) return ''
          const records: TypingRecord[] = Object.values(state.typing ?? {})
          const typers = records.flatMap(
            ({ channelId, threadTs, memberId, memberIsSelf }) =>
              channelId === conversation.channelId &&
              (threadTs ?? undefined) === conversation.threadTs &&
              !memberIsSelf &&
              memberId
                ? [
                    {
                      id: memberId,
                      name: nameOf(state, state.members?.[memberId]),
                    },
                  ]
                : []
          )
          return typers.length ? JSON.stringify(typers) : ''
        })
        const typers = React.useMemo<Typer[]>(
          () => (json ? JSON.parse(json) : []),
          [json]
        )

        const line = React.useRef<HTMLSpanElement>(null)
        const sample = React.useRef<HTMLSpanElement>(null)
        const boldSample = React.useRef<HTMLElement>(null)
        const [box, setBox] = React.useState<Box | null>(null)
        const shown = typers.length > 0 && !!phrases
        React.useLayoutEffect(() => {
          const element = line.current
          const text = sample.current
          const bold = boldSample.current
          if (!element || !text || !bold) return
          const update = () => {
            const { fontFamily, fontSize, letterSpacing, fontWeight } =
              getComputedStyle(element)
            const next: Box = {
              width: element.clientWidth,
              sample: text.getBoundingClientRect().width,
              fontFamily,
              fontSize,
              letterSpacing,
              regularWeight: fontWeight,
              boldWeight: getComputedStyle(bold).fontWeight,
            }
            setBox((prev) =>
              prev &&
              (Object.keys(next) as (keyof Box)[]).every(
                (key) => prev[key] === next[key]
              )
                ? prev
                : next
            )
          }
          // read before paint, so the first frame already fits
          update()
          // font change or something
          const observer = new ResizeObserver(update)
          observer.observe(element)
          observer.observe(text)
          return () => observer.disconnect()
        }, [shown])

        if (!shown || !phrases) return <Original {...props} />

        const texts = box
          ? this.fit(typers, phrases, box)
          : typers.map(({ name }) => name)
        const links = texts.map((text, i) => (
          <MemberLink
            key={typers[i].id}
            id={typers[i].id}
            className="taut-typing-indicator__member"
          >
            {text}
          </MemberLink>
        ))
        const named = texts.length
        const others = typers.slice(named)
        const last = others.length ? (
          <Tooltip tip={others.map(({ name }) => name).join(', ')}>
            <span>{phrases.others(others.length)}</span>
          </Tooltip>
        ) : (
          links.pop()
        )
        // Slack's "<b>A</b> and <b>B</b> are typing", with the rest of the list in A
        return (
          <span ref={line} className="taut-typing-indicator">
            <span
              ref={sample}
              className="taut-typing-indicator__sample"
              aria-hidden
            >
              typing <b ref={boldSample}>typing</b>
            </span>
            {links.length ? (
              <Original
                firstTyper={join(links)}
                secondTyper={last}
                severalPeopleAreTyping={false}
              />
            ) : (
              <Original firstTyper={last} severalPeopleAreTyping={false} />
            )}
          </span>
        )
      }
    )
  }

  /** `text` cut between graphemes and ended with an ellipsis, if it's wider than `width` */
  private truncate(
    text: string,
    width: number,
    font: string,
    letterSpacing: string
  ): string {
    if (this.textWidth(text, font, letterSpacing) <= width) return text
    const graphemes = Array.from(
      this.graphemes.segment(text),
      ({ segment }) => segment
    )
    const ellipsis = String.fromCodePoint(0x2026)
    const cut = (count: number) =>
      `${graphemes.slice(0, count).join('').trimEnd()}${ellipsis}`
    let low = 0
    let high = graphemes.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (this.textWidth(cut(mid), font, letterSpacing) <= width) low = mid
      else high = mid - 1
    }
    return cut(low)
  }

  /** the text of each typer to name in `box`, cut to fit */
  private fit(typers: Typer[], phrases: Phrases, box: Box): string[] {
    const regular = `${box.regularWeight} ${box.fontSize} ${box.fontFamily}`
    const bold = `${box.boldWeight} ${box.fontSize} ${box.fontFamily}`
    const measure = (text: string, font: string) =>
      this.textWidth(text, font, box.letterSpacing)
    const em = Number.parseFloat(box.fontSize)
    // a pixel each for the subpixel rounding between canvas and layout
    const names = typers.map(({ name }) => measure(name, bold) + 1)
    const floors = typers.map(({ name }, i) =>
      !/\s/.test(name) && names[i] <= WORD_MAX_EMS * em
        ? names[i]
        : Math.min(names[i], NAME_MIN_EMS * em)
    )

    /** the width left for names when the first `named` are shown */
    const room = (named: number) => {
      const rest = names.length - named
      const around = named > 1 || rest ? phrases.two : phrases.one
      const others = rest ? measure(phrases.others(rest), bold) + 1 : 0
      const commas = rest ? named - 1 : Math.max(named - 2, 0)
      return (
        box.width -
        around.reduce((sum, piece) => sum + measure(piece, regular), 0) -
        others -
        commas * measure(', ', regular)
      )
    }
    const fits = (named: number) =>
      floors.slice(0, named).reduce((sum, floor) => sum + floor, 0) <=
      room(named)

    let named = 1
    if (fits(names.length)) named = names.length
    else while (named + 1 < names.length && fits(named + 1)) named++

    // water-filling: names at their floor stay whole, the rest share the room equally
    const shown = names.slice(0, named)
    const uncut = (i: number) => floors[i] === shown[i]
    const level = waterLevel(
      shown.filter((_, i) => !uncut(i)),
      shown.reduce(
        (left, width, i) => (uncut(i) ? left - width : left),
        room(named)
      )
    )
    return typers
      .slice(0, named)
      .map(({ name }, i) =>
        uncut(i) || level === undefined
          ? name
          : this.truncate(
              name,
              Math.max(level, floors[i]) - 1,
              bold,
              box.letterSpacing
            )
      )
  }
}

/** Slack's translated typing sentences, split where the names go */
function phrasesFrom(I18n: I18nClass): Phrases {
  const typing = new I18n('notification_bar')
  // the "N others" from Slack's Today view
  const today = new I18n('today')
  // private use characters hold the names' places
  const name = String.fromCodePoint(0xe000)
  const otherName = String.fromCodePoint(0xe001)
  const pieces = (text: string) =>
    text
      .replace(/<\/?b>/g, '')
      .split(name)
      .flatMap((piece) => piece.split(otherName))
  const others = new Map<number, string>()
  return {
    one: pieces(typing.t('<b>{name}</b> is typing', { name })),
    two: pieces(
      typing.t('<b>{name}</b> and <b>{other_name}</b> are typing', {
        name,
        other_name: otherName,
      })
    ),
    others: (count) => {
      let label = others.get(count)
      if (label === undefined) {
        label = today.t('{count, plural, =1 {# other} other {# others}}', {
          count,
        })
        others.set(count, label)
      }
      return label
    },
  }
}

/** the largest cap that fits `widths` in `room` with every width cut to it, if any must be cut */
function waterLevel(widths: number[], room: number): number | undefined {
  if (widths.reduce((sum, width) => sum + width, 0) <= room) return undefined
  const sorted = [...widths].sort((a, b) => a - b)
  let left = room
  for (const [i, width] of sorted.entries()) {
    const share = left / (sorted.length - i)
    if (width > share) return share
    left -= width
  }
  return undefined
}

function join(nodes: React.ReactNode[]): React.ReactNode {
  return nodes.flatMap((node, i) => (i ? [', ', node] : [node]))
}
