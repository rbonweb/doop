import { main } from './cli.ts'

/* the executable: Ctrl-C stops the run, which closes the browser and the local server before the process leaves */
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

process.exitCode = await main(process.argv.slice(2), { signal: controller.signal })
