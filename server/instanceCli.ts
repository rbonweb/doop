import pg from 'pg'
import { normalizeAdminEmail, setAdminRole } from './adminRole.ts'
import { env } from './env.ts'
import {
  createInvite,
  inviteLink,
  listInvites,
  modelSettings,
  revokeInvite,
  setModels,
  SettingRefused,
} from './instanceConfig.ts'

/**
 * deploy/doop.sh's way into the instance settings from the server's command
 * line, run inside the app container:
 *
 *   tsx server/instanceCli.ts invite EMAIL...      a link per address
 *   tsx server/instanceCli.ts invite-token EMAIL   just the token (for doop.sh admin)
 *   tsx server/instanceCli.ts invites              the links waiting to be used
 *   tsx server/instanceCli.ts uninvite EMAIL
 *   tsx server/instanceCli.ts models [agent|distill NAME]   NAME "default" clears it
 *   tsx server/instanceCli.ts admin EMAIL            makes an existing account an admin
 *   tsx server/instanceCli.ts admin --remove EMAIL   takes the role away
 *
 * The running server reads the same file on every use, so nothing restarts.
 * admin needs DATABASE_URL, a real Postgres: the embedded database cannot be opened by a second process.
 */

const BY = 'the server command line'

async function run(command: string | undefined, args: string[]): Promise<void> {
  switch (command) {
    case 'invite':
      for (const email of args) {
        const invite = createInvite(email, BY)
        console.log(`${invite.email}  ${inviteLink(invite)}`)
      }
      return
    case 'invite-token':
      console.log(createInvite(args[0] ?? '', BY).token)
      return
    case 'invites':
      for (const invite of listInvites()) {
        console.log(
          `${invite.email}  expires ${new Date(invite.expiresAt).toISOString().slice(0, 10)}  ${inviteLink(invite)}`,
        )
      }
      return
    case 'uninvite':
      if (!revokeInvite(args[0] ?? '')) throw new SettingRefused(`No invite for ${args[0] ?? 'that address'}.`)
      return
    case 'models': {
      const [which, name] = args
      if (which === 'agent' || which === 'distill') {
        if (!name) throw new SettingRefused(`Usage: models ${which} NAME (or "default")`)
        setModels({ [which]: name === 'default' ? '' : name })
      } else if (which !== undefined) {
        throw new SettingRefused('Usage: models [agent|distill NAME]')
      }
      const models = modelSettings()
      console.log(`agent    ${models.agent.value}${models.agent.value === models.agent.default ? '  (default)' : ''}`)
      console.log(
        `distill  ${models.distill.value}${models.distill.value === models.distill.default ? '  (default)' : ''}`,
      )
      return
    }
    case 'admin': {
      const remove = args[0] === '--remove'
      const raw = remove ? args[1] : args[0]
      if (raw === undefined || args.length !== (remove ? 2 : 1)) {
        throw new SettingRefused('Usage: admin EMAIL (or admin --remove EMAIL)')
      }
      let email: string
      try {
        email = normalizeAdminEmail(raw)
      } catch (e) {
        throw new SettingRefused(e instanceof Error ? e.message : String(e))
      }
      const url = env.DATABASE_URL
      if (!url) {
        throw new SettingRefused(
          'admin needs DATABASE_URL: the embedded database cannot be opened by a second process.',
        )
      }
      const client = new pg.Client({ connectionString: url })
      let changed: boolean
      try {
        await client.connect()
        changed = await setAdminRole(client, email, !remove)
      } catch {
        throw new SettingRefused('Could not reach the database.')
      } finally {
        await client.end().catch(() => {})
      }
      if (!changed) {
        if (remove) throw new SettingRefused(`${email} is not an admin`)
        throw new SettingRefused(`No account for ${email}. Create it first (sign up through an invite link).`)
      }
      console.log(remove ? `${email} is no longer an admin.` : `${email} is an admin: Admin is in the account menu.`)
      return
    }
    default:
      throw new SettingRefused(`Unknown command ${command ?? '(none)'}`)
  }
}

run(process.argv[2], process.argv.slice(3)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
