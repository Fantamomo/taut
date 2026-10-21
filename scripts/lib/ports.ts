import net from 'node:net'

export async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 200; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net
        .createServer()
        .once('error', () => resolve(false))
        .once('listening', () => server.close(() => resolve(true)))
        .listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  throw new Error(`no free port near ${from}`)
}
