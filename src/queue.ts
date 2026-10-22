export type Priority = 'interactive' | 'batch'

export const PRIORITIES: readonly Priority[] = ['interactive', 'batch']

interface Task {
  run: () => Promise<void>
}

// Runs one task at a time, every waiting interactive task before any batch
// task. Callers split a batch into one task per text, so an interactive call
// waits for at most the one embedding already running.
export class PriorityQueue {
  private lanes: Record<Priority, Task[]> = { interactive: [], batch: [] }
  private running = false

  push<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.lanes[priority].push({ run: () => fn().then(resolve, reject) })
      void this.drain()
    })
  }

  depths(): Record<Priority, number> {
    return { interactive: this.lanes.interactive.length, batch: this.lanes.batch.length }
  }

  get busy(): boolean {
    return this.running || this.lanes.interactive.length > 0 || this.lanes.batch.length > 0
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const task = this.lanes.interactive.shift() ?? this.lanes.batch.shift()
        if (!task) break
        await task.run()
      }
    } finally {
      this.running = false
    }
  }
}
