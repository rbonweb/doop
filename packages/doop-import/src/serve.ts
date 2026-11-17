import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

/** A tiny static server for a `storybook build` directory, on 127.0.0.1 at a random port: the Storybook runs on this machine and nowhere else. */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/**
 * The file a request path names inside `root`, or null when it names anything else: a `..` step, an encoded one (`%2e%2e`, `%2f`), a backslash, a NUL, or a malformed escape. A directory (a path ending in `/`) means its `index.html`. Pure, so the refusals are testable without a socket; the server also resolves symlinks before it opens anything.
 */
export function resolveRequestPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded.split('/').filter((segment) => segment !== '')
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  const target = path.join(root, ...segments, ...(decoded.endsWith('/') ? ['index.html'] : []))
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return target
}

export interface StaticServer {
  /** `http://127.0.0.1:<port>` */
  origin: string
  close: () => Promise<void>
}

/** Serves `directory` (read only, GET and HEAD) until `close()`. Requests that are not for this server's own address are refused, so a web page elsewhere cannot reach the build through DNS rebinding. */
export async function serveDirectory(directory: string): Promise<StaticServer> {
  const root = await realpath(path.resolve(directory))
  let host = ''

  const send = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' })
    res.end(message)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.host !== host) return send(res, 403, 'forbidden')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      return send(res, 405, 'method not allowed')
    }
    const urlPath = (req.url ?? '/').split(/[?#]/, 1)[0] ?? '/'
    let file = resolveRequestPath(root, urlPath)
    if (!file) return send(res, 400, 'bad path')
    try {
      let info = await stat(file)
      if (info.isDirectory()) {
        /* /sb to /sb/, so relative urls on the page resolve */
        res.writeHead(301, { location: `/${urlPath.replace(/^\/+/, '')}/` })
        return void res.end()
      }
      /* a symlink inside the build must not lead out of it */
      file = await realpath(file)
      const inside = path.relative(root, file)
      if (inside.startsWith('..') || path.isAbsolute(inside)) return send(res, 403, 'forbidden')
      info = await stat(file)
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': info.size,
        'x-content-type-options': 'nosniff',
      })
      if (req.method === 'HEAD') return void res.end()
      const stream = createReadStream(file)
      stream.on('error', () => res.destroy())
      stream.pipe(res)
    } catch {
      send(res, 404, 'not found')
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy()
      else send(res, 500, 'error')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  host = `127.0.0.1:${port}`
  return {
    origin: `http://${host}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
