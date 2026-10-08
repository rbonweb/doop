import {
  createInvite,
  inviteLink,
  listInvites,
  modelSettings,
  revokeInvite,
  setModels,
  SettingRefused,
} from './instanceSettings.ts'

/**
 * deploy/doop.sh's way into the instance settings from the server's command
 * line, run inside the app container:
 *
 *   tsx server/instanceCli.ts invite EMAIL...      a link per address
 *   tsx server/instanceCli.ts invite-token EMAIL   just the token (for doop.sh admin)
 *   tsx server/instanceCli.ts invites              the links waiting to be used
 *   tsx server/instanceCli.ts uninvite EMAIL
 *   tsx server/instanceCli.ts models [agent|distill NAME]   NAME "default" clears it
 *
 * The running server reads the same file on every use, so nothing restarts.
 */

const BY = 'the server command line'

function run(command: string | undefined, args: string[]): void {
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
    default:
      throw new SettingRefused(`Unknown command ${command ?? '(none)'}`)
  }
}

try {
  run(process.argv[2], process.argv.slice(3))
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
