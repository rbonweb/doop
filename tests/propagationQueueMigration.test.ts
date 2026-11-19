import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../server/db/migrations/0065_component_propagation_queue.sql', import.meta.url),
  'utf8',
).replaceAll('--> statement-breakpoint', '')

it('creates the propagation queue table, and runs again over an existing one without losing a row', async () => {
  const db = new PGlite()
  try {
    await db.exec(migration)
    await db.query(
      `INSERT INTO component_propagation_queue (frame_id, task, canvas_id, component_ids, actor, queued_at)
       VALUES ('f1', 'propagate', 'c1', '["a"]', '{"name":"T"}', 1)`,
    )
    await db.exec(migration)
    expect((await db.query('SELECT frame_id, task FROM component_propagation_queue')).rows).toEqual([
      { frame_id: 'f1', task: 'propagate' },
    ])
    /* one row per frame and task */
    await expect(
      db.query(
        `INSERT INTO component_propagation_queue (frame_id, task, canvas_id, component_ids, actor, queued_at)
         VALUES ('f1', 'propagate', 'c1', '[]', '{}', 2)`,
      ),
    ).rejects.toThrow()
    await db.query(
      `INSERT INTO component_propagation_queue (frame_id, task, canvas_id, component_ids, actor, queued_at)
       VALUES ('f1', 'detach', 'c1', '[]', '{}', 2)`,
    )
  } finally {
    await db.close()
  }
})
