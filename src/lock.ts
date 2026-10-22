import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'

export function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// A recycled pid that now belongs to something else does not hold the lock.
function isServiceProcess(pid: number): boolean {
  if (!alive(pid)) return false
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
    return /purecontext-embed|@purecontext\/embed|embed\/dist\/cli\.js/.test(args) && /\bserve\b/.test(args)
  } catch {
    return true
  }
}

// The lock decides which of several racing `serve` processes owns the socket.
// A stale lock is moved aside by rename, which only one racer can win; the
// winner checks it moved the stale file and not a lock just taken by another.
export function acquireLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const holder = readLockPid(lockPath)
    if (holder === null) {
      let age = 0
      try {
        age = Date.now() - statSync(lockPath).mtimeMs
      } catch {
        continue
      }
      if (age < 10_000) return false
    } else if (isServiceProcess(holder)) {
      return false
    }
    const aside = `${lockPath}.stale-${process.pid}`
    try {
      renameSync(lockPath, aside)
    } catch {
      continue
    }
    if (readLockPid(aside) !== holder) {
      try {
        renameSync(aside, lockPath)
      } catch {}
      return false
    }
    try {
      unlinkSync(aside)
    } catch {}
  }
  return false
}
