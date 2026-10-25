import { within } from '../helpers'
import { Store } from '../store'
import { getReduxStore, waitForClientStore } from './redux'
import { byMeta, byName, waitForExport } from './webpack'

/**
 * a decoded huddle peer message (`calls/client/peer_message.proto`)
 * usually one field set, priority order below
 */
export type PeerMessage = {
  jukeboxRequest?: { songKey?: string; stop?: boolean }
  reacji?: { emoji?: string; type?: number; emojiUrl?: string }
  draw?: unknown
  capabilities?: { isDrawEnabled?: boolean }
  muteRequest?: { peerId?: string }
  contentShareDetails?: { sourceType?: string; itemId?: string }
  kickNotification?: { kickedUserId?: string }
  [key: string]: unknown
}

// the order Slack's client checks a peer message's fields in, if else chain
const PEER_MESSAGE_PRIORITY = [
  'jukeboxRequest',
  'reacji',
  'draw',
  'capabilities',
  'muteRequest',
  'contentShareDetails',
  'kickNotification',
] as const

export type PeerMessageKind = (typeof PEER_MESSAGE_PRIORITY)[number]

export type PeerMessageEvent = {
  message: PeerMessage
  kind: PeerMessageKind | undefined
  /** from Chime, trusted */
  senderAttendeeId: string
  selfAttendeeId: string
}

export type PeerMessageListener = (event: PeerMessageEvent) => void

/** a huddle in Slack's `allCalls` slice, comes from the websocket's `room` */
export type HuddleCall = {
  id: string
  name?: string
  createdBy?: string
  channels?: string[]
  locale?: string
  backgroundId?: string
  hasEnded?: boolean
  [key: string]: unknown
}

const peerListeners = new Set<PeerMessageListener>()
let selfAttendeeId: string | undefined

type Selector = (state: any) => string | undefined

const MISSING_MS = 30_000
const REACTION_WAIT_MS = 3000

const reactionAction = waitForExport<(payload: object) => object>(
  byMeta('sendReactionMessage')
)

export type ActiveHuddle = { callId: string; channelId?: string }

const activeHuddle = new Store<ActiveHuddle | undefined>(undefined)
// the subscription that updates activeHuddle
const following = (async () => {
  const store = await waitForClientStore()
  const selectCallId = await waitForExport<Selector>(
    byMeta('getActiveHuddleCallId')
  )
  const selectChannelId = await waitForExport<Selector>(
    byMeta('getActiveHuddleChannelId')
  )
  const read = () => {
    const state = store.getState()
    const callId = selectCallId(state)
    const channelId = selectChannelId(state)
    const now = activeHuddle.get()
    if (now?.callId === callId && now?.channelId === channelId) return
    activeHuddle.set(callId ? { callId, channelId } : undefined)
  }
  store.subscribe(read)
  read()
  return true
})()

let needed = false
// logs once if the active huddle still isn't followed MISSING_MS after something first needs it
function needActiveHuddle(): ActiveHuddle | undefined {
  if (!needed) {
    needed = true
    within(following, MISSING_MS, 'The active huddle')
  }
  return activeHuddle.get()
}

export type HuddleReaction = {
  /** an emoji or effect name */
  emoji: string
  kind: 'standard' | 'effect' | 'gif'
  /** shown in place of the emoji, fetched by viewers through Slack's image proxy */
  imageUrl?: string
}

/** send a reaction into the current huddle as yourself, resolves false if there's no huddle to send it to */
export async function sendReaction(reaction: HuddleReaction): Promise<boolean> {
  if (!needActiveHuddle()) return false
  const store = await waitForClientStore()
  const create = await within(
    reactionAction,
    REACTION_WAIT_MS,
    "Slack's huddle reaction action"
  )
  if (!create) return false
  store.dispatch(
    create({
      emoji: reaction.emoji,
      reactionType: reaction.kind,
      emojiUrl: reaction.imageUrl,
    })
  )
  return true
}

// every data-channel message reaches this, decoded
waitForExport<any>(byName('AudioVideoFacadeSubscriber')).then((Subscriber) => {
  const proto = Subscriber?.prototype
  const original = proto?.handlePeerMessageFromDataMessage
  if (typeof original !== 'function') {
    console.error('[Taut] Huddle peer messages are unavailable')
    return
  }
  proto.handlePeerMessageFromDataMessage = function (
    this: { selfAttendeeId?: string },
    message: PeerMessage,
    senderAttendeeId: string,
    ...rest: unknown[]
  ) {
    if (this.selfAttendeeId) selfAttendeeId = this.selfAttendeeId
    if (message && senderAttendeeId && selfAttendeeId) {
      const kind = PEER_MESSAGE_PRIORITY.find((field) => message[field])
      const event = { message, kind, senderAttendeeId, selfAttendeeId }
      for (const listener of [...peerListeners]) {
        try {
          listener(event)
        } catch (err) {
          console.error('[Taut] Huddle peer message listener threw', err)
        }
      }
    }
    return original.call(this, message, senderAttendeeId, ...rest)
  }
})

/** listen for messages huddle participants send each other (mutes, kicks, reactions...), returns a disposer */
export function onPeerMessage(listener: PeerMessageListener): () => void {
  peerListeners.add(listener)
  return () => {
    peerListeners.delete(listener)
  }
}

/** the user behind a Chime attendee id in the current huddle, including people who left */
export function getAttendeeUserId(attendeeId: string): string | undefined {
  const state = getReduxStore()?.getState()
  if (attendeeId === selfAttendeeId) return state?.bootData?.user_id
  const peers = state?.peers
  return (peers?.byId?.[attendeeId] ?? peers?.leftById?.[attendeeId])?.userId
}

/** a huddle by its room id (`R...`), as Slack has it stored */
export function getCall(roomId: string): HuddleCall | undefined {
  return getReduxStore()?.getState().allCalls?.byId?.[roomId]
}

/** calls `listener` now and whenever the huddle this client is in or joining changes, returns a disposer */
export function onActiveHuddle(
  listener: (huddle: ActiveHuddle | undefined) => void
): () => void {
  listener(needActiveHuddle())
  return activeHuddle.subscribe(() => listener(activeHuddle.get()))
}

/** the huddle this client is in or joining right now, for a user action */
export function getActiveHuddle(): ActiveHuddle | undefined {
  return needActiveHuddle()
}

export const huddlesPromise = (async () => {
  return {
    onPeerMessage,
    getAttendeeUserId,
    getCall,
    onActiveHuddle,
    getActiveHuddle,
    sendReaction,
  }
})()

export type HuddlesAPI = Awaited<typeof huddlesPromise>
