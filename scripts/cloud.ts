#!/usr/bin/env node

// Runs Slack with Taut in Chromium on a Linux VM such as a Claude Code cloud environment, run with --help

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { type Cdp, cdpJson, connect } from './lib/cdp.ts'
import { chromeExtensionId } from './lib/chromeExtension.ts'
import { DIST, ROOT } from './lib/paths.ts'
import { freePort } from './lib/ports.ts'

const USAGE = `usage: node scripts/cloud.ts <command> [--name <tab>] [args]

Runs Slack with Taut in Chromium on Linux, signed in with $SLACK_D_COOKIE, for
Claude Code cloud environments. Each checkout, worktrees included, gets its own
browser, profile and dev server, and each named tab in it gets its own window
(default name: main). State, ports and logs go in tmp-cloud/.

up                   starts the dev server, Xvfb and Chromium unless they're
                     running, and opens the tab at $SLACK_URL unless it's open,
                     waiting up to 60s for Slack to load
eval <js>            evaluates in the tab and prints the result as JSON (top
                     level await works)
cdp <method> [json]  sends a CDP command to the tab and prints the result,
                     --browser sends it to the browser instead
shot [file]          screenshots the tab (default tmp-cloud/<tab>.png)
down                 stops everything

A - in place of <js> or [json] reads it from stdin. For more (events, several
commands on one connection), import { tab, browser } from this file, which
return a connection with send(method, params, sessionId?) and on(listener).
The main checkout uses devtools port 9222 and dev server port 3000 when they're
free, for chrome-devtools-mcp --browserUrl.

CLOUD_EXTENSION=<dir> makes up load that unpacked extension instead of Taut's,
with no dev server (run down first to switch).
`

const STATE = path.join(ROOT, 'tmp-cloud')
const TABS = path.join(STATE, 'tabs')
const PORTS = path.join(STATE, 'ports.json')
// a worktree's .git is a file, and worktrees look for ports above the main checkout's
const MAIN = statSync(path.join(ROOT, '.git'), {
  throwIfNoEntry: false,
})?.isDirectory()
const SLACK_URL = process.env.SLACK_URL || 'https://app.slack.com/client'
const EXTENSION = process.env.CLOUD_EXTENSION
const CHROME_BIN = process.env.CHROME_BIN || '/opt/pw-browsers/chromium'

function fail(message: string): never {
  console.error(`[cloud] ${message}`)
  process.exit(1)
}

/** starts a process that outlives this one, logging to <name>.log */
function start(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  /** pipes for fds from 3 up, read from the returned child's stdio */
  pipes: 'pipe'[] = []
): ChildProcess {
  const log = openSync(path.join(STATE, `${name}.log`), 'a')
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', log, log, ...pipes],
    env,
  })
  child.on('error', (err) => fail(`${command}: ${err.message}`))
  child.unref()
  writeFileSync(path.join(STATE, `${name}.pid`), String(child.pid))
  return child
}

function run(command: string, args: string[], env = process.env) {
  const { status } = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  })
  if (status !== 0) fail(`${command} ${args.join(' ')} exited ${status}`)
}

/** whether a process start() launched is still running */
function alive(name: string) {
  try {
    process.kill(
      Number(readFileSync(path.join(STATE, `${name}.pid`), 'utf8')),
      0
    )
    return true
  } catch {
    return false
  }
}

interface Ports {
  cdp: number
  dev: number
  display: number
}

const readPorts = (): Partial<Ports> =>
  existsSync(PORTS) ? JSON.parse(readFileSync(PORTS, 'utf8')) : {}
const savePorts = (ports: Partial<Ports>) =>
  writeFileSync(PORTS, JSON.stringify(ports))

const responds = (url: string) =>
  fetch(url).then(
    (res) => res.ok,
    () => false
  )

async function until<T>(
  get: () => Promise<T>,
  what: string,
  timeout = 120_000
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await get().catch(() => null)
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

/** a CDP connection to the browser */
export async function browser(): Promise<Cdp> {
  const { cdp } = readPorts()
  if (!cdp) fail('Not running, run up first')
  const { webSocketDebuggerUrl } = await cdpJson<{
    webSocketDebuggerUrl: string
  }>(cdp, '/json/version')
  return connect(webSocketDebuggerUrl)
}

const tabFile = (name: string) => path.join(TABS, name)

async function tabTarget(name: string) {
  if (!existsSync(tabFile(name))) return undefined
  const id = readFileSync(tabFile(name), 'utf8')
  const { cdp } = readPorts()
  if (!cdp) return undefined
  const targets = await cdpJson<any[]>(cdp, '/json/list').catch(() => [])
  return targets.find((t) => t.id === id)
}

/** a CDP connection to a tab that up opened */
export async function tab(name = 'main'): Promise<Cdp> {
  const target = await tabTarget(name)
  if (!target) fail(`No tab named ${name}, run up --name ${name}`)
  return connect(target.webSocketDebuggerUrl)
}

/** points taut's extension at the dev server from its options page, which can reach its storage */
async function setTautUrl(cdp: Cdp, port: number) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${chromeExtensionId()}/options.html`,
  })
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  await until(
    async () =>
      (
        await cdp.send(
          'Runtime.evaluate',
          {
            expression: `chrome.storage.local.set({ tautUrl: 'http://localhost:${port}/taut.js' }).then(() => true)`,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId
        )
      ).result.value,
    'the extension'
  )
  await cdp.send('Target.closeTarget', { targetId })
}

/** launches chromium signed in, with taut's extension pointed at the dev server unless CLOUD_EXTENSION replaces it, records its devtools port and returns the id of the tab it opened */
async function launchChromium(
  cookie: string,
  ports: Partial<Ports>,
  cdpPort: number
): Promise<string> {
  const env = { ...process.env }
  if (!env.DISPLAY) env.DISPLAY = `:${ports.display}`
  const profile = path.join(STATE, 'profile')
  // chromium writes the port it bound here, which tells apart a port another browser took first
  const activePort = path.join(profile, 'DevToolsActivePort')
  rmSync(activePort, { force: true })
  start(
    'chromium',
    CHROME_BIN,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${cdpPort}`,
      `--load-extension=${EXTENSION ? path.resolve(EXTENSION) : path.join(DIST, 'extension', 'chrome')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,900',
      // the sandbox refuses to run as root
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
    env
  )
  ports.cdp = await until(
    async () => Number(readFileSync(activePort, 'utf8').split('\n')[0]),
    'Chromium'
  )
  savePorts(ports)

  const cdp = await browser()
  await cdp.send('Storage.setCookies', {
    cookies: [
      {
        name: 'd',
        value: cookie,
        domain: '.slack.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        expires: Date.now() / 1000 + 365 * 86400,
      },
    ],
  })
  const blank = await cdpJson<any[]>(ports.cdp, '/json/list')
  if (!EXTENSION && ports.dev) await setTautUrl(cdp, ports.dev)
  const { targetId } = await cdp.send('Target.createTarget', {
    url: SLACK_URL,
  })
  for (const t of blank)
    if (t.type === 'page')
      await cdp.send('Target.closeTarget', { targetId: t.id })
  cdp.close()
  return targetId
}

// agents may run up at the same time
async function locked(fn: () => Promise<void>) {
  const lock = path.join(STATE, 'lock')
  await until(async () => {
    try {
      mkdirSync(lock)
      return true
    } catch {
      return false
    }
  }, 'another up to finish (down clears a stale lock)')
  try {
    await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

// a loaded client is titled "<view> - <workspace> - Slack"
async function waitForSlack(name: string) {
  const cdp = await tab(name)
  const deadline = Date.now() + 60_000
  let page = { title: '', url: '' }
  do {
    if (Date.now() > deadline) {
      console.warn(
        `[cloud] Slack hasn't loaded after 60s, the tab is at ${page.url} titled "${page.title}"`
      )
      break
    }
    await sleep(500)
    const { result } = await cdp
      .send('Runtime.evaluate', {
        expression: '({ title: document.title, url: location.href })',
        returnByValue: true,
      })
      .catch(() => ({ result: { value: page } }))
    page = result.value ?? page
  } while (!/ - .+ - Slack$/.test(page.title))
  cdp.close()
}

async function up(name: string) {
  const cookie = process.env.SLACK_D_COOKIE
  if (!cookie) fail("Set SLACK_D_COOKIE to the test account's d cookie")
  mkdirSync(TABS, { recursive: true })

  let opened = false
  await locked(async () => {
    if (!EXTENSION && !existsSync(path.join(ROOT, 'node_modules')))
      run('npm', ['ci'], { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' })

    const ports = readPorts()
    // the dev server's new port, which a running chromium's extension has to be pointed at
    let movedDev: number | undefined
    if (!EXTENSION && !alive('dev')) {
      // another checkout can take the port between freePort and the dev server's listen, so check who answers
      let port = MAIN ? 3000 : 3001
      for (; ; port++) {
        port = await freePort(port)
        console.log(`[cloud] Starting the dev server on ${port}`)
        const dev = start(
          'dev',
          process.execPath,
          [path.join(ROOT, 'scripts', 'dev.ts')],
          { ...process.env, PORT: String(port) }
        )
        const devUrl = `http://localhost:${port}/taut.js`
        const answered = await until(async () => {
          if (dev.exitCode !== null) return 'exited'
          const res = await fetch(devUrl)
          return res.headers.get('x-taut-checkout') === ROOT ? 'ours' : null
        }, 'the dev server')
        if (answered === 'ours') break
        if (!(await responds(devUrl)))
          fail(`The dev server exited, see ${path.join(STATE, 'dev.log')}`)
      }
      if (port !== ports.dev) movedDev = port
      ports.dev = port
      savePorts(ports)
    }

    if (!process.env.DISPLAY && !alive('xvfb')) {
      // xvfb picks a free display itself and writes it to fd 3 once it accepts connections
      const xvfb = start(
        'xvfb',
        'Xvfb',
        ['-displayfd', '3', '-screen', '0', '1440x900x24'],
        process.env,
        ['pipe']
      )
      let display = ''
      for await (const chunk of xvfb.stdio[3] as Readable) {
        display += chunk
        if (display.includes('\n')) break
      }
      if (!display.trim())
        fail(`Xvfb exited, see ${path.join(STATE, 'xvfb.log')}`)
      ports.display = Number(display)
      savePorts(ports)
    }

    if (!alive('chromium')) {
      if (!EXTENSION)
        run(process.execPath, [
          path.join(ROOT, 'scripts', 'build.ts'),
          'extension',
        ])
      // 0 has chromium pick a free port
      const cdpPort = MAIN && (await freePort(9222)) === 9222 ? 9222 : 0
      console.log('[cloud] Starting Chromium')
      writeFileSync(tabFile(name), await launchChromium(cookie, ports, cdpPort))
      console.log(`[cloud] Chromium has devtools on ${ports.cdp}`)
      opened = true
    } else {
      if (movedDev) {
        const cdp = await browser()
        await setTautUrl(cdp, movedDev)
        cdp.close()
        console.log(
          `[cloud] The dev server moved to ${movedDev}, reload open tabs`
        )
      }
      if (!(await tabTarget(name))) {
        const cdp = await browser()
        const { targetId } = await cdp.send('Target.createTarget', {
          url: SLACK_URL,
          newWindow: true,
        })
        cdp.close()
        writeFileSync(tabFile(name), targetId)
        opened = true
      }
    }
  })
  if (opened) await waitForSlack(name)
  console.log(`[cloud] Tab ${name} is open, logs in ${STATE}`)
}

function down() {
  if (!existsSync(STATE)) return
  for (const file of readdirSync(STATE).filter((f) => f.endsWith('.pid'))) {
    try {
      process.kill(-Number(readFileSync(path.join(STATE, file), 'utf8')))
    } catch {}
    rmSync(path.join(STATE, file))
  }
  rmSync(TABS, { recursive: true, force: true })
  rmSync(PORTS, { force: true })
  rmSync(path.join(STATE, 'lock'), { recursive: true, force: true })
}

if (process.argv[1] === import.meta.filename) {
  const [command, ...args] = process.argv.slice(2)
  let name = 'main'
  let toBrowser = false
  while (args[0]?.startsWith('--')) {
    const flag = args.shift()
    if (flag === '--name') name = args.shift() ?? fail('--name needs a value')
    else if (flag === '--browser') toBrowser = true
    else fail(`Unknown option ${flag}\n\n${USAGE}`)
  }
  const input = (arg?: string) => (arg === '-' ? readFileSync(0, 'utf8') : arg)

  if (command === 'up') await up(name)
  else if (command === 'down') down()
  else if (command === 'eval' && args[0]) {
    const cdp = await tab(name)
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression: input(args[0]),
      awaitPromise: true,
      returnByValue: true,
      replMode: true,
    })
    cdp.close()
    if (exceptionDetails)
      fail(exceptionDetails.exception?.description ?? exceptionDetails.text)
    console.log(JSON.stringify(result.value, null, 2) ?? 'undefined')
  } else if (command === 'cdp' && args[0]) {
    const cdp = toBrowser ? await browser() : await tab(name)
    const params = input(args[1])
    const result = await cdp
      .send(args[0], params ? JSON.parse(params) : {})
      .catch((err) => fail(err.message))
    cdp.close()
    console.log(JSON.stringify(result, null, 2))
  } else if (command === 'shot') {
    const cdp = await tab(name)
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
    })
    cdp.close()
    const file = args[0] ?? path.join(STATE, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(file)
  } else {
    console.log(USAGE)
    process.exit(command === undefined || command === '--help' ? 0 : 1)
  }
}
