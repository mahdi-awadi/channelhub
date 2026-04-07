// tests/task-monitor.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskMonitor, parseTaskFile } from '../src/task-monitor'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

const TEST_DIR = join(import.meta.dir, '.test-tasks')

describe('TaskMonitor', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('parseTaskFile parses task JSON', () => {
    const task = parseTaskFile(JSON.stringify({
      id: '1',
      subject: 'Fix auth',
      description: 'Fix the login bug',
      status: 'in_progress',
      owner: 'teammate-2',
      blockedBy: [],
    }))
    expect(task.id).toBe('1')
    expect(task.subject).toBe('Fix auth')
    expect(task.status).toBe('in_progress')
    expect(task.owner).toBe('teammate-2')
  })

  test('readTasks returns empty array for missing directory', () => {
    const monitor = new TaskMonitor(TEST_DIR)
    const tasks = monitor.readTasks()
    expect(tasks).toEqual([])
  })

  test('readTasks finds task files', () => {
    const taskDir = join(TEST_DIR, 'my-team')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'task-1.json'), JSON.stringify({
      id: '1', subject: 'Test', status: 'pending', owner: '', blockedBy: [],
    }))
    const monitor = new TaskMonitor(TEST_DIR)
    const tasks = monitor.readTasks('my-team')
    expect(tasks.length).toBe(1)
    expect(tasks[0].subject).toBe('Test')
  })
})
