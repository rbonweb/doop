import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { expect, it as run } from 'vitest'
import { startServer } from './harness'

/* Linux answers on all of 127.0.0.0/8; macOS only has 127.0.0.1 on lo0, so 127.0.0.2 cannot be reached there at all */
const hasAlternateLoopback = await new Promise<boolean>((resolve) => {
  const probe = createServer()
  probe.once('error', () => resolve(false))
  probe.listen(0, '127.0.0.2', () => probe.close(() => resolve(true)))
})
const it = run.skipIf(!hasAlternateLoopback)

async function connectToAlternateLoopback(port: number): Promise<void> {
  const socket = createConnection({ host: '127.0.0.2', port })
  try {
    await once(socket, 'connect')
  } finally {
    socket.destroy()
  }
}

it('listens on IPv4 and IPv6 interfaces by default', async () => {
  const server = await startServer({ HOST: '' })
  try {
    await expect(connectToAlternateLoopback(server.port)).resolves.toBeUndefined()
    expect((await fetch(`http://[::1]:${server.port}/healthz`)).ok).toBe(true)
    expect(server.startupUrl).toBe(`http://localhost:${server.port}`)
    expect((await fetch(`${server.base}/healthz`)).ok).toBe(true)
  } finally {
    server.stop()
    await server.stopped
  }
}, 30_000)

it('restricts connections to the configured interface', async () => {
  const server = await startServer({ HOST: '127.0.0.1' })
  try {
    expect((await fetch(`${server.base}/healthz`)).ok).toBe(true)
    expect(server.startupUrl).toBe(`http://127.0.0.1:${server.port}`)
    await expect(connectToAlternateLoopback(server.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  } finally {
    server.stop()
    await server.stopped
  }
}, 30_000)

it('listens on the configured IPv6 interface and prints a valid URL', async () => {
  const server = await startServer({ HOST: '::1' })
  try {
    expect(server.startupUrl).toBe(`http://[::1]:${server.port}`)
    expect((await fetch(`${server.startupUrl}/healthz`)).ok).toBe(true)
    await expect(connectToAlternateLoopback(server.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  } finally {
    server.stop()
    await server.stopped
  }
}, 30_000)
