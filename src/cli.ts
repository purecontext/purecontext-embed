#!/usr/bin/env node
import { serviceStatus, stopService } from './client.js'
import { servicePaths } from './paths.js'
import { serve } from './serve.js'

const USAGE = `usage: purecontext-embed <command>

  serve [--home <dir>]  run the embed service in the foreground
  status [--json]       show the service, its loaded models and its queue;
                        exits 2 when the service is not running
  stop                  stop the service`

const [command, ...args] = process.argv.slice(2)

const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const m = (Date.now() - Date.parse(iso)) / 60_000
  return m < 60 ? `${Math.round(m)} min ago` : `${Math.round(m / 60)} h ago`
}
const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`

switch (command) {
  case 'serve': {
    const at = args.indexOf('--home')
    const service = await serve(at === -1 ? servicePaths() : servicePaths(args[at + 1]))
    process.on('SIGTERM', () => void service.stop('SIGTERM'))
    process.on('SIGINT', () => void service.stop('SIGINT'))
    await service.done
    process.exit(0)
    break
  }
  case 'status': {
    const json = args.includes('--json')
    const status = await serviceStatus()
    if (!status) {
      console.log(json ? JSON.stringify({ running: false }) : 'embed service is not running')
      process.exit(2)
    }
    if (json) {
      console.log(JSON.stringify({ running: true, ...status }, null, 2))
      break
    }
    console.log(`embed service ${status.version} (pid ${status.pid}), started ${ago(status.startedAt)}`)
    console.log(`  memory ${mb(status.memory.rss)} resident, last request ${ago(status.lastRequestAt)}`)
    console.log(`  queue ${status.queue.interactive} interactive, ${status.queue.batch} batch`)
    if (status.models.length === 0) console.log('  no model loaded yet')
    for (const m of status.models) {
      console.log(`  ${m.state.padEnd(7)} ${m.dir}`)
      if (m.state === 'failed') console.log(`          ${m.error}`)
      else console.log(`          ${m.count} embedded, ${m.dims ?? '?'} dims, last used ${ago(m.lastUsedAt)}`)
    }
    break
  }
  case 'stop':
    console.log((await stopService()) ? 'stopped' : 'embed service is not running')
    break
  default:
    console.error(USAGE)
    process.exit(command ? 64 : 0)
}
