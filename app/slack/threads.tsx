import { within } from '../helpers'
import { patchComponentPromise } from './react'
import { getReduxStore } from './redux'
import { byMeta, waitForExport } from './webpack'

/** the thread pane a component renders in */
export type ThreadPane = {
  channelId: string
  threadTs: string
  windowId: string
  /** the replies the pane has loaded, one contiguous run */
  loaded(): string[]
  /** the reply at the top edge */
  topReply(): string | undefined
  /** highlights a reply and scrolls it to the top of the pane, loading it first if needed, false if it never loaded */
  jumpToReply(ts: string): Promise<boolean>
}

type PaneInstance = {
  /** scrolls a loaded reply to the top edge, false if it isn't loaded */
  scrollToTs?: (ts: string) => boolean
  listRef?: {
    current?: { getScrollmark?: () => { mark?: string } | undefined } | null
  }
}
type PaneProps = {
  channelId?: string
  threadTs?: string
  windowId?: string
  timestamps?: string[]
  /** changes with every jumpToReply */
  highlightKey?: string
  ref?: React.Ref<PaneInstance>
}
type JumpAction = (args: {
  windowId?: string
  threadKey: string
  ts: string
}) => object
type Pending = { ts: string; done: (scrolled: boolean) => void }

const ACTION_WAIT_MS = 5000
const LOAD_WAIT_MS = 5000

const jumpAction = waitForExport<JumpAction>(byMeta('jumpToReply'))

let paneContext: React.Context<ThreadPane | null> | undefined
// react isn't available at module load
const PaneContext = () =>
  (paneContext ??= React.createContext<ThreadPane | null>(null))

let reportedMissing = false

/** the thread pane this component renders in, or null outside one */
function usePane(): ThreadPane | null {
  return React.useContext(PaneContext())
}
export const threads = { usePane }

patchComponentPromise.then((patchComponent) => {
  const Context = PaneContext()

  patchComponent<PaneProps>(
    'Serialized(ThreadsFlexpane)',
    (Original) => (props) => {
      const latest = React.useRef(props)
      latest.current = props
      const instance = React.useRef<PaneInstance | null>(null)
      const pending = React.useRef<Pending | null>(null)

      const ref = React.useCallback((value: PaneInstance | null) => {
        instance.current = value
        const outer = latest.current.ref
        if (typeof outer === 'function') outer(value)
        else if (outer) (outer as { current: unknown }).current = value
      }, [])

      const { channelId, threadTs, windowId = 'main' } = props
      const pane = React.useMemo<ThreadPane | null>(() => {
        if (!channelId || !threadTs) return null
        return {
          channelId,
          threadTs,
          windowId,
          loaded: () => latest.current.timestamps ?? [],
          topReply: () =>
            instance.current?.listRef?.current?.getScrollmark?.()?.mark,
          jumpToReply: async (ts) => {
            const action = await within(
              jumpAction,
              ACTION_WAIT_MS,
              "Slack's jumpToReply action"
            )
            const view = instance.current
            if (!action || !view) return false
            if (typeof view.scrollToTs !== 'function') {
              if (!reportedMissing)
                console.error(
                  "[Taut] Slack's thread pane scrollToTs is unavailable"
                )
              reportedMissing = true
              return false
            }
            pending.current?.done(false)
            const scrolled = new Promise<boolean>((resolve) => {
              const done = (scrolled: boolean) => {
                clearTimeout(timer)
                if (pending.current?.done === done) pending.current = null
                resolve(scrolled)
              }
              const timer = setTimeout(() => done(false), LOAD_WAIT_MS)
              pending.current = { ts, done }
            })
            getReduxStore()?.dispatch(
              action({ windowId, threadKey: `${channelId}-${threadTs}`, ts })
            )
            return scrolled
          },
        }
      }, [channelId, threadTs, windowId])

      // runs after slack's lazy jump scroll, and again as replies load (slack only scrolls to loaded ones)
      React.useEffect(() => {
        const waiting = pending.current
        if (waiting && instance.current?.scrollToTs?.(waiting.ts))
          waiting.done(true)
      }, [props.timestamps, props.highlightKey])
      React.useEffect(() => () => pending.current?.done(false), [])

      return (
        <Context.Provider value={pane}>
          <Original {...props} ref={ref} />
        </Context.Provider>
      )
    }
  )
})
