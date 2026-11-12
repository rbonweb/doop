import { env } from './env.ts'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'

/**
 * Byte storage for uploaded assets. With bucket credentials configured the
 * bytes live in S3-compatible object storage — the env names match what a
 * Railway Bucket injects via variable references (BUCKET, ACCESS_KEY_ID,
 * SECRET_ACCESS_KEY, ENDPOINT, REGION); R2 or S3 work with the same names.
 * Without them (local development) bytes land under ./data/assets, next to
 * PGlite. Either way the assets table is the source of truth for what exists.
 */

const BUCKET = env.BUCKET
const DISK_DIR = path.join(process.cwd(), 'data', 'assets')

export const storageMode: 'bucket' | 'disk' = BUCKET ? 'bucket' : 'disk'

/* keys are `<nanoid>.<ext>`, optionally under the `thumb/` prefix (derived
   frame previews — a folder of their own so they can be purged or lifecycle-
   ruled without touching user uploads), the `bg/` prefix (the curated
   background library, server/backgrounds.ts) or the `render/` prefix (derived
   full-size frame renders, server/renderStore.ts). Anything else is a bug, and
   in disk mode the check doubles as the path-traversal guard: known literal
   prefixes, no dots or slashes in the name. */
function assertKey(key: string) {
  if (!/^(thumb\/|bg\/|render\/)?[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(key)) throw new Error(`malformed storage key: ${key}`)
}

let s3: S3Client | undefined
async function client(): Promise<S3Client> {
  if (!s3) {
    /* loaded on demand so dev without a bucket never pays for the SDK */
    const { S3Client } = await import('@aws-sdk/client-s3')
    s3 = new S3Client({
      region: env.REGION,
      endpoint: env.ENDPOINT,
      credentials:
        env.ACCESS_KEY_ID && env.SECRET_ACCESS_KEY
          ? { accessKeyId: env.ACCESS_KEY_ID, secretAccessKey: env.SECRET_ACCESS_KEY }
          : undefined,
    })
  }
  return s3
}

export async function putObject(key: string, body: Buffer, mime: string): Promise<void> {
  assertKey(key)
  if (BUCKET) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await (await client()).send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: mime }))
    return
  }
  await fs.mkdir(path.dirname(path.join(DISK_DIR, key)), { recursive: true })
  await fs.writeFile(path.join(DISK_DIR, key), body)
}

export async function deleteObject(key: string): Promise<void> {
  assertKey(key)
  if (BUCKET) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await (await client()).send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
    return
  }
  await fs.rm(path.join(DISK_DIR, key), { force: true })
}

export async function getObject(key: string, signal?: AbortSignal): Promise<Buffer | null> {
  assertKey(key)
  if (BUCKET) {
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3')
      const out = await (
        await client()
      ).send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), { abortSignal: signal })
      return Buffer.from(await out.Body!.transformToByteArray())
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null
      throw e
    }
  }
  try {
    return await fs.readFile(path.join(DISK_DIR, key), { signal })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

const RENDER_PREFIX = /^render\/[A-Za-z0-9_-]*$/

/** Every object whose key starts with a `render/` prefix (`render/` alone lists them all), with size and last-modified time. Bucket listings paginate; disk listings skip names `assertKey` would reject. */
export async function listObjects(
  prefix: `render/${string}`,
): Promise<Array<{ key: string; size: number; modified: number }>> {
  if (!RENDER_PREFIX.test(prefix)) throw new Error(`malformed list prefix: ${prefix}`)
  if (BUCKET) {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
    const out: Array<{ key: string; size: number; modified: number }> = []
    let token: string | undefined
    do {
      const res = await (
        await client()
      ).send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }))
      for (const o of res.Contents ?? [])
        if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, modified: o.LastModified?.getTime() ?? 0 })
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
    return out
  }
  const dir = path.join(DISK_DIR, 'render')
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const namePrefix = prefix.slice('render/'.length)
  const out: Array<{ key: string; size: number; modified: number }> = []
  for (const name of names) {
    if (!name.startsWith(namePrefix)) continue
    try {
      assertKey(`render/${name}`)
    } catch {
      continue
    }
    try {
      const st = await fs.stat(path.join(dir, name))
      if (!st.isFile()) continue
      out.push({ key: `render/${name}`, size: st.size, modified: st.mtimeMs })
    } catch {
      /* raced away between readdir and stat */
    }
  }
  return out
}
