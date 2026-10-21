// a CDP connection, attached targets multiplexed over it by sessionId

export interface Cdp {
  send<T = any>(method: string, params?: object, sessionId?: string): Promise<T>
  /** returns an unsubscribe function */
  on(listener: (event: { method: string; params: any }) => void): () => void
  close(): void
}

export function connect(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map<number, (result: any, error?: any) => void>()
    const listeners = new Set<(event: any) => void>()
    let nextId = 1

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.id !== 'number') {
        for (const listener of listeners) listener(message)
        return
      }
      pending.get(message.id)?.(message.result, message.error)
      pending.delete(message.id)
    })
    ws.addEventListener('error', () => reject(new Error(`cannot open ${url}`)))
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}, sessionId) {
          const id = nextId++
          ws.send(JSON.stringify({ id, method, params, sessionId }))
          return new Promise((ok, fail) => {
            pending.set(id, (result, error) =>
              error
                ? fail(new Error(`${method}: ${error.message}`))
                : ok(result)
            )
          })
        },
        on(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        close: () => ws.close(),
      })
    )
  })
}

export const cdpJson = async <T>(port: number, route: string): Promise<T> => {
  const res = await fetch(new URL(route, `http://127.0.0.1:${port}`))
  if (!res.ok) throw new Error(`${route} responded ${res.status}`)
  return res.json() as Promise<T>
}
