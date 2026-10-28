// Taut Userscript main

import { userscriptBridge } from './bridge'

declare const unsafeWindow: Window
declare function GM_getValue<T>(key: string, defaultValue: T): T
declare function GM_setValue(key: string, value: unknown): void
declare function GM_registerMenuCommand(name: string, fn: () => void): void
declare function GM_openInTab(url: string, opts?: { active?: boolean }): void
declare const __TAUT_OPTIONS_HTML__: string
declare const __TAUT_EMBEDDED__: boolean
declare const __TAUT_APP_JS__: string

const OFFICIAL_URL = 'https://taut.jer.app/taut.js'
const DEFAULT_URL = __TAUT_EMBEDDED__ ? '<embedded>' : OFFICIAL_URL
const OPTIONS_URL = 'https://taut.jer.app/options'

// parallel to desktop/src/preload.ts, extension/chrome/content.js, and extension/firefox/background.js

async function readPage(response: Response) {
  const type = response.headers.get('content-type') ?? ''
  const sameOrigin = new URL(response.url).origin === location.origin
  if (!response.ok || !sameOrigin || !type.startsWith('text/html'))
    throw new Error(
      `Unexpected response: ${response.status} ${response.url} ${type}`
    )
  return response.text()
}

function reloadWithoutTaut(error: unknown) {
  console.error('[Taut] Failed to rewrite the page:', error)
  try {
    sessionStorage.setItem('taut_rewrite_failed', '1')
  } catch {
    return
  }
  location.reload()
}

unsafeWindow.tautPrefs = {
  getUrl: () => Promise.resolve(GM_getValue('tautUrl', DEFAULT_URL)),
  setUrl: (url) => {
    GM_setValue('tautUrl', url)
    return Promise.resolve()
  },
}

if (location.href.startsWith(OPTIONS_URL)) {
  document.open()
  document.write(__TAUT_OPTIONS_HTML__)
  document.close()
} else {
  GM_registerMenuCommand('Taut Options', () =>
    GM_openInTab(OPTIONS_URL, { active: true })
  )
  GM_registerMenuCommand('Reload in Safe Mode', () => {
    sessionStorage.setItem('taut_safe_mode_once', '1')
    location.reload()
  })

  unsafeWindow.TautBridge = userscriptBridge

  ;(async () => {
    let rewriteFailed = false
    try {
      rewriteFailed = sessionStorage.getItem('taut_rewrite_failed') !== null
      sessionStorage.removeItem('taut_rewrite_failed')
    } catch {}
    if (rewriteFailed) {
      console.warn('[Taut] Loading Slack without Taut after a failed rewrite')
      return
    }

    document.open()
    document.write('<!DOCTYPE html>')
    document.close()

    const tautUrl = GM_getValue('tautUrl', DEFAULT_URL)
    const html = await fetch(location.href).then(readPage)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove()

    const scripts = Array.from(doc.querySelectorAll('script')).map((s) => ({
      src: s.src,
      textContent: s.textContent,
      type: s.getAttribute('type'),
    }))
    doc.querySelectorAll('script').forEach((s) => {
      s.remove()
    })

    const scriptError = (url: string) =>
      `alert('[Taut] Failed to load a script.\\n\\nURL: ' + ${JSON.stringify(url)} + '\\n\\n${url.includes('://localhost') ? 'Make sure your server is running.' : 'Ask in #taut for help.'}')`

    const tautScript = doc.createElement('script')
    tautScript.id = 'taut-app'
    if (__TAUT_EMBEDDED__ && tautUrl === '<embedded>') {
      tautScript.textContent = __TAUT_APP_JS__
    } else {
      // '<embedded>' saved by an embedded copy means the official url in one without taut.js
      tautScript.src = tautUrl === '<embedded>' ? OFFICIAL_URL : tautUrl
      tautScript.setAttribute('onerror', scriptError(tautScript.src))
    }
    doc.head.appendChild(tautScript)

    for (const { src, textContent, type } of scripts) {
      const s = doc.createElement('script')
      if (type) s.type = type
      if (src) s.src = src
      else if (textContent) s.textContent = textContent
      doc.head.appendChild(s)
    }

    document.open()
    document.write(`<!DOCTYPE html>${doc.documentElement.outerHTML}`)
    document.close()

    console.log(
      '[Taut] Document reconstructed with CSP removed and taut.js injected'
    )
  })().catch(reloadWithoutTaut)
}
