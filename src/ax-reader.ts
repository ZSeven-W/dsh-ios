import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Reader { read(signal?: AbortSignal): Promise<string>; close(): void }
const readers = new Map<string, Reader>()

/** Pinned AXe framework host; never caches a tree or a frontmost element. */
export function readWithAxeSession(command: string, udid: string, signal?: AbortSignal): Promise<string> | undefined {
  signal?.throwIfAborted()
  const frameworks = join(dirname(command), 'Frameworks')
  const executable = fileURLToPath(new URL('../assets/ax-reader/dsh-ax-reader', import.meta.url))
  if (process.platform !== 'darwin' || !existsSync(executable) || !existsSync(join(frameworks, 'FBSimulatorControl.framework'))) return undefined
  const key = `${command}:${udid}`
  let reader = readers.get(key)
  if (!reader) {
    const child = spawn(executable, [udid], { stdio: 'pipe', env: { ...process.env, DYLD_FRAMEWORK_PATH: frameworks } })
    let closed = false, buffer = '', queue: Promise<unknown> = Promise.resolve()
    let pending: { resolve(s: string): void; reject(e: Error): void } | undefined
    let idle: ReturnType<typeof setTimeout> | undefined
    const close = (): void => {
      if (closed) return
      closed = true; clearTimeout(idle)
      if (readers.get(key) === reader) readers.delete(key)
      process.off('exit', close)
      const request = pending; pending = undefined
      request?.reject(new Error('Duo accessibility reader disconnected'))
      child.stdin.end(); child.kill()
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 8 * 1024 * 1024) { close(); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        const request = pending; pending = undefined
        if (!request) { close(); return }
        try {
          const data: unknown = JSON.parse(line)
          if (!Array.isArray(data)) {
            const message = (data as { error?: unknown } | null)?.error
            throw new Error(typeof message === 'string' ? message : 'Invalid accessibility reader response')
          }
          request.resolve(line)
        } catch (error) { request.reject(error instanceof Error ? error : new Error(String(error))); close() }
      }
    })
    child.stderr.resume(); child.on('error', close); child.on('exit', close); child.stdin.on('error', close)
    child.unref()
    for (const pipe of [child.stdin, child.stdout, child.stderr]) (pipe as unknown as { unref?: () => void }).unref?.()
    process.once('exit', close)
    reader = { close, read(signal) {
      const task = queue.catch(() => {}).then(() => new Promise<string>((resolve, reject) => {
        signal?.throwIfAborted()
        if (closed) { reject(new Error('Duo accessibility reader disconnected')); return }
        clearTimeout(idle)
        const timeout = setTimeout(close, 20_000)
        const abort = (): void => close()
        signal?.addEventListener('abort', abort, { once: true })
        const finish = (): void => {
          clearTimeout(timeout); signal?.removeEventListener('abort', abort)
          if (!closed) { idle = setTimeout(close, 60_000); idle.unref() }
        }
        pending = { resolve(value) { finish(); resolve(value) }, reject(error) { finish(); reject(error) } }
        child.stdin.write('get\n')
      }))
      queue = task
      return task
    } }
    readers.set(key, reader)
  }
  return reader.read(signal)
}

export function closeAxeReaders(): void { for (const reader of readers.values()) reader.close() }
