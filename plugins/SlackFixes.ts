// Fixes small bugs in Slack's UI

import { TautPlugin } from '$taut'

export default class SlackFixes extends TautPlugin<typeof SlackFixes> {
  static readonly id = 'SlackFixes'
  static readonly pluginName = 'Slack Fixes'
  static readonly description = "Fixes small bugs in Slack's UI"
  static readonly authors = ['jeremy'] as const
  static readonly category = 'app'
  static readonly defaultConfig = {
    enabled: true,
  }

  start(): void {
    this.api.setStyle(`
      /* halloween sidebar row */
      [data-qa="spooky_sidebar_candy_icon"] {
        width: 16px;
        padding-right: 0;
        justify-content: center;
      }
      [class*="spookySidebarLinkContainer__"] { border-radius: 6px; }
    `)
    this.log('Started')
  }
}
