// Adds "Join channel" to the right-click menu of channels you're not in

import { type MenuTemplateItem, TautPlugin } from '$taut'

type Channel = {
  is_channel?: boolean
  is_private?: boolean
  is_member?: boolean
  is_archived?: boolean
  properties?: { code_channel?: unknown }
}

export default class QuickJoin extends TautPlugin<typeof QuickJoin> {
  static readonly id = 'QuickJoin'
  static readonly pluginName = 'Quick Join'
  static readonly description =
    'Adds "Join channel" to the right-click menu of channels you\'re not in'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'app'
  static readonly defaultConfig = {
    enabled: false,
  }

  private readonly joinChannel =
    this.api.redux.waitForThunkCreator('joinChannel')

  start(): void {
    // the right-click menu on a channel link, sidebar row or header
    this.api.redux.patchThunk(
      'getContextMenuTemplate',
      (original) =>
        (args: { id?: string }, ...rest: unknown[]) => {
          const thunk = original(args, ...rest)
          return (
            dispatch: (action: unknown) => unknown,
            getState: () => any,
            ...more: unknown[]
          ) => {
            const template: MenuTemplateItem[] = thunk(
              dispatch,
              getState,
              ...more
            )
            const channelId = args?.id
            if (!channelId || !canJoin(getState().channels?.[channelId]))
              return template
            return [
              ...template,
              { key: 'taut-quick-join__separator', type: 'separator' },
              {
                key: 'taut-quick-join__join',
                label: 'Join channel',
                click: () => this.join(dispatch, channelId),
              },
            ]
          }
        }
    )
  }

  private async join(
    dispatch: (action: unknown) => unknown,
    channelId: string
  ) {
    const create = await this.api.within(
      this.joinChannel,
      10_000,
      "Slack's joinChannel action"
    )
    if (!create) return
    try {
      await dispatch(create({ channelId }))
    } catch (error) {
      this.log('could not join', channelId, error)
    }
  }
}

// code channels join through joinCodeChannel, which needs a channel the link was seen in
const canJoin = (channel: Channel | undefined): boolean =>
  !!channel &&
  channel.is_channel === true &&
  !channel.is_private &&
  !channel.is_member &&
  !channel.is_archived &&
  !channel.properties?.code_channel
