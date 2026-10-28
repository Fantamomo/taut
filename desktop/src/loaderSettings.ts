// Taut Desktop Settings: the ones Taut's settings screen draws through TautBridge.loaderSettings

import { app } from 'electron'
import type { TautLoaderSetting } from '../../shared/TautBridge'
import { getNativeFrame, savePrefs } from './prefs.js'

type Setting = {
  label: string
  subtext?: string
  get(): boolean
  set(value: boolean): Promise<void>
  /** for settings only read at launch */
  restart?: boolean
}

const settings: Record<string, Setting> = {
  ...(process.platform === 'linux' && {
    nativeFrame: {
      label: 'Use the system title bar and menu bar',
      get: getNativeFrame,
      set: (nativeFrame: boolean) => savePrefs({ nativeFrame }),
      restart: true,
    },
  }),
}

const atLaunch = new Map<string, boolean>()

/** call once after prefs load, before anything reads them */
export function recordLaunchSettings() {
  for (const [id, setting] of Object.entries(settings))
    if (setting.restart) atLaunch.set(id, setting.get())
}

export async function listLoaderSettings(): Promise<TautLoaderSetting[]> {
  return Object.entries(settings).map(([id, setting]) => {
    const value = setting.get()
    const launched = atLaunch.get(id)
    return {
      id,
      label: setting.label,
      subtext: setting.subtext,
      value,
      restartPending: launched !== undefined && launched !== value,
    }
  })
}

export async function setLoaderSetting(id: string, value: unknown) {
  const setting = Object.hasOwn(settings, id) ? settings[id] : undefined
  if (!setting || typeof value !== 'boolean') return false
  try {
    await setting.set(value)
    return true
  } catch {
    return false
  }
}

export function relaunch() {
  // relaunch the AppImage itself, its mount goes away when this quits
  const { APPIMAGE } = process.env
  app.relaunch(
    APPIMAGE ? { execPath: APPIMAGE, args: process.argv.slice(1) } : undefined
  )
  app.quit()
}
