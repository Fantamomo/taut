// Taut userscript bridge: TautBridge on GM_* APIs

import type { BlobStore, TautBridge, TautCookie } from '../shared/TautBridge'
import { defaultUserCss } from '../shared/userCss'

declare const __TAUT_LOADER_VERSION__: string

declare function GM_getValue<T>(key: string, defaultValue?: T): T
declare function GM_setValue(key: string, value: unknown): void
declare function GM_listValues(): string[]
declare function GM_deleteValue(key: string): void
declare function GM_addValueChangeListener(
  key: string,
  callback: (
    key: string,
    oldValue: unknown,
    newValue: unknown,
    remote: boolean
  ) => void
): number
declare function GM_removeValueChangeListener(listenerId: number): void
declare function GM_xmlhttpRequest(details: {
  method?: string
  url: string
  headers?: Record<string, string>
  data?: string
  anonymous?: boolean
  responseType?: 'arraybuffer' | 'blob' | 'json' | 'stream'
  onload?: (response: {
    status: number
    statusText: string
    /** an ArrayBuffer with responseType 'arraybuffer' */
    response: unknown
    responseText?: string
    responseHeaders: string
  }) => void
  onerror?: (response: { error: string }) => void
}): void

type GMCookie = {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
  sameSite?: string
}
declare const GM_cookie:
  | undefined
  | {
      list(
        details: {
          url?: string
          domain?: string
          name?: string
          path?: string
        },
        cb: (cookies: GMCookie[], error?: string) => void
      ): void
      set(
        details: GMCookie & { url: string },
        cb: (error?: string) => void
      ): void
      delete(
        details: { url?: string; name: string },
        cb: (error?: string) => void
      ): void
    }

function makePrefixedBlobStore(prefix: string): BlobStore {
  return {
    async list() {
      return GM_listValues()
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
    },
    async read(key) {
      return GM_getValue(prefix + key, null)
    },
    async write(key, value) {
      try {
        GM_setValue(prefix + key, value)
        return true
      } catch {
        return false
      }
    },
    async delete(key) {
      try {
        GM_deleteValue(prefix + key)
        return true
      } catch {
        return false
      }
    },
    async clear() {
      try {
        for (const k of GM_listValues()) {
          if (k.startsWith(prefix)) GM_deleteValue(k)
        }
        return true
      } catch {
        return false
      }
    },
  }
}

function makeBlobStore(namespace: string): BlobStore {
  return makePrefixedBlobStore(`taut:blob:${encodeURIComponent(namespace)}:`)
}

const gmCookie = typeof GM_cookie !== 'undefined' ? GM_cookie : null
const secretsBlob = makePrefixedBlobStore('taut-secret:')

function validUserPlugins(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = Object.create(null)
  for (const [id, code] of Object.entries(value)) {
    if (typeof code === 'string') result[id] = code
  }
  return result
}

function readUserPlugins(): Record<string, string> {
  return validUserPlugins(GM_getValue('taut-user-plugins', {}))
}

async function updateUserPlugins(
  update: (plugins: Record<string, string>) => void
): Promise<boolean> {
  if (!navigator.locks) return false
  try {
    return await navigator.locks.request('taut:user-plugins', async () => {
      const plugins = readUserPlugins()
      update(plugins)
      GM_setValue('taut-user-plugins', plugins)
      return true
    })
  } catch {
    return false
  }
}

const cookies: TautBridge['cookies'] = gmCookie
  ? {
      get: ({ url, name }) =>
        new Promise((resolve) =>
          gmCookie.list({ url, name }, (list) =>
            resolve((list?.[0] as TautCookie) ?? null)
          )
        ),
      getAll: (details) =>
        new Promise((resolve) =>
          gmCookie.list(details, (list) =>
            resolve((list as TautCookie[]) ?? [])
          )
        ),
      set: (cookie) =>
        new Promise((resolve) =>
          gmCookie.set(cookie as GMCookie & { url: string }, (err) =>
            resolve(!err)
          )
        ),
      remove: ({ url, name }) =>
        new Promise((resolve) =>
          gmCookie.delete({ url, name }, (err) => resolve(!err))
        ),
    }
  : null

// parallel to desktop/src/preload.ts and extension/shared/bridge-setup.template.js

export const userscriptBridge: TautBridge = {
  loader: 'userscript',
  loaderVersion: __TAUT_LOADER_VERSION__,
  bridgeVersion: 3,
  embedded: __TAUT_EMBEDDED__,
  PATHS: null,

  cookies,

  readSecret: (key) => secretsBlob.read(key),
  writeSecret: (key, value) => secretsBlob.write(key, value),
  deleteSecret: (key) => secretsBlob.delete(key),

  userPlugins: {
    list: async () => Object.keys(readUserPlugins()),
    read: async (id) => readUserPlugins()[id] ?? null,
    write: (id, code) =>
      updateUserPlugins((plugins) => {
        plugins[id] = code
      }),
    delete: (id) =>
      updateUserPlugins((plugins) => {
        delete plugins[id]
      }),
    onChange(cb) {
      const listenerId = GM_addValueChangeListener(
        'taut-user-plugins',
        (_key, oldValue, newValue, remote) => {
          if (!remote) return
          const oldPlugins = validUserPlugins(oldValue)
          const newPlugins = validUserPlugins(newValue)
          for (const id of new Set([
            ...Object.keys(oldPlugins),
            ...Object.keys(newPlugins),
          ])) {
            if (oldPlugins[id] !== newPlugins[id])
              cb(id, newPlugins[id] ?? null)
          }
        }
      )
      return () => GM_removeValueChangeListener(listenerId)
    },
  },

  blobStore: makeBlobStore,

  async start() {
    if (!GM_getValue('taut-user-css')) {
      GM_setValue('taut-user-css', defaultUserCss)
    }
  },

  readConfigText: async () => GM_getValue('taut-config', '') as string,
  async writeConfigText(text) {
    try {
      GM_setValue('taut-config', text)
      return true
    } catch {
      return false
    }
  },

  onConfigTextChange(cb) {
    const listenerId = GM_addValueChangeListener(
      'taut-config',
      (_key, _oldValue, newValue, remote) => {
        if (remote && typeof newValue === 'string') cb(newValue)
      }
    )
    return () => GM_removeValueChangeListener(listenerId)
  },

  readUserCss: async () =>
    GM_getValue('taut-user-css', defaultUserCss) as string,
  async writeUserCss(text) {
    try {
      GM_setValue('taut-user-css', text)
      return true
    } catch {
      return false
    }
  },

  onUserCssChange(cb) {
    const listenerId = GM_addValueChangeListener(
      'taut-user-css',
      (_key, _oldValue, newValue, remote) => {
        if (remote && typeof newValue === 'string') cb(newValue)
      }
    )
    return () => GM_removeValueChangeListener(listenerId)
  },

  fetch(input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const headers: Record<string, string> = {}
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v
        })
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v
      } else {
        Object.assign(headers, init.headers)
      }
    }
    const hasCookie = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .includes('cookie')
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: (init?.method ?? 'GET').toUpperCase(),
        url,
        headers,
        data: typeof init?.body === 'string' ? init.body : undefined,
        anonymous: hasCookie,
        // raw bytes, so binary bodies survive (responseText decodes them)
        responseType: 'arraybuffer',
        onload(r) {
          const responseHeaders = new Headers()
          for (const line of r.responseHeaders.trim().split('\r\n')) {
            const idx = line.indexOf(':')
            if (idx > 0)
              responseHeaders.append(
                line.slice(0, idx).trim(),
                line.slice(idx + 1).trim()
              )
          }
          // possibly from the manager's realm, so no instanceof
          const buffer = r.response as ArrayBuffer | null | undefined
          const body =
            typeof buffer?.byteLength === 'number'
              ? new Uint8Array(buffer)
              : (r.responseText ?? '')
          resolve(
            // these statuses need a null body or the Response constructor throws
            new Response(
              [101, 204, 205, 304].includes(r.status) ? null : body,
              {
                status: r.status,
                statusText: r.statusText,
                headers: responseHeaders,
              }
            )
          )
        },
        onerror(r) {
          reject(new Error(r.error))
        },
      })
    })
  },

  warnOutdated() {
    alert(
      '[Taut] Your Taut userscript is outdated. Please update it from https://taut.jer.app/taut.user.js'
    )
  },
}
