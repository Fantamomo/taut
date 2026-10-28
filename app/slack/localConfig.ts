export type LocalConfigTeam = {
  id?: string
  name?: string
  domain?: string
  user_id?: string
  token?: string
  url?: string
  [key: string]: unknown
}

export type LocalConfig = {
  teams?: Record<string, LocalConfigTeam>
  lastActiveTeamId?: string
  orderedTeamIds?: string[]
  [key: string]: unknown
}

export function readLocalConfig(): LocalConfig {
  try {
    return JSON.parse(localStorage.getItem('localConfig_v2') || '{}')
  } catch {
    return {}
  }
}

/** the team in `/client/<id>/...`, which is the one this page booted into */
export const urlTeamId = (): string | undefined =>
  /^\/client\/([TE][A-Z0-9]+)/.exec(location.pathname)?.[1]

/** this tab's team, from the route when it has one, since every tab shares `lastActiveTeamId` */
export function getActiveTeamId(
  config: LocalConfig = readLocalConfig()
): string | undefined {
  const routeTeamId = urlTeamId()
  if (routeTeamId && config.teams?.[routeTeamId]) return routeTeamId
  return config.lastActiveTeamId
}

/** the localConfig team entry for this tab's workspace */
export function getActiveTeam(
  config: LocalConfig = readLocalConfig()
): LocalConfigTeam | undefined {
  const teamId = getActiveTeamId(config)
  return teamId ? config.teams?.[teamId] : undefined
}
