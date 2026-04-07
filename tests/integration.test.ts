// tests/integration.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import { rmSync } from 'fs'
import { SessionRegistry } from '../src/session-registry'
import { SocketServer } from '../src/socket-server'
import { PermissionEngine } from '../src/permission-engine'
import { MessageRouter } from '../src/message-router'
import { connect } from 'net'

const TEST_SOCK = join(import.meta.dir, '.test-integration.sock')

describe('integration: shim → daemon flow', () => {
  let registry: SessionRegistry
  let socketServer: SocketServer
  let permissions: PermissionEngine
  let router: MessageRouter
  const deliveredToFrontend: Array<{ sessionName: string; text: string }> = []
  const sentToSession: Array<{ path: string; content: string }> = []

  beforeEach(async () => {
    deliveredToFrontend.length = 0
    sentToSession.length = 0
    rmSync(TEST_SOCK, { force: true })

    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    permissions = new PermissionEngine(registry, () => {})

    socketServer = new SocketServer(registry, TEST_SOCK)

    router = new MessageRouter(
      registry,
      (path, content) => {
        sentToSession.push({ path, content })
        return socketServer.sendToSession(path, {
          type: 'channel_message',
          content,
          meta: { source: 'hub', frontend: 'test', user: 'test', session: '' },
        })
      },
      (sessionName, text) => {
        deliveredToFrontend.push({ sessionName, text })
      },
    )

    socketServer.on('tool_call', (path: string, name: string, args: Record<string, unknown>) => {
      if (name === 'reply') {
        router.routeFromSession(path, args.text as string)
        socketServer.sendToSession(path, {
          type: 'tool_result',
          name: 'reply',
          result: 'sent',
        })
      }
    })

    await socketServer.start()
  })

  afterEach(async () => {
    await socketServer.stop()
    rmSync(TEST_SOCK, { force: true })
  })

  test('full message round-trip: frontend → session → frontend', async () => {
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sock.write(JSON.stringify({ type: 'register', cwd: '/home/user/myproject' }) + '\n')

    const regData = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const regMsg = JSON.parse(regData.trim())
    expect(regMsg.type).toBe('registered')
    expect(regMsg.sessionName).toBe('myproject')

    router.routeToSession('myproject', 'hello claude', 'web', 'user1')

    const msgData = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const channelMsg = JSON.parse(msgData.trim())
    expect(channelMsg.type).toBe('channel_message')
    expect(channelMsg.content).toBe('hello claude')

    sock.write(JSON.stringify({ type: 'tool_call', name: 'reply', arguments: { text: 'hello human' } }) + '\n')

    await new Promise(r => setTimeout(r, 100))
    expect(deliveredToFrontend.length).toBe(1)
    expect(deliveredToFrontend[0].text).toBe('hello human')

    sock.end()
  })

  test('permission auto-approve for trusted session', async () => {
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sock.write(JSON.stringify({ type: 'register', cwd: '/home/user/trusted' }) + '\n')
    await new Promise<string>(resolve => { sock.once('data', chunk => resolve(chunk.toString())) })

    registry.setTrust('/home/user/trusted:0', 'auto-approve')

    socketServer.on('permission_request', (path: string, msg: any) => {
      const response = permissions.handle(path, msg)
      if (response) {
        socketServer.sendToSession(path, {
          type: 'permission_response',
          requestId: response.requestId,
          behavior: response.behavior,
        })
      }
    })

    sock.write(JSON.stringify({
      type: 'permission_request',
      requestId: 'abcde',
      toolName: 'Bash',
      description: 'run ls',
      inputPreview: 'ls',
    }) + '\n')

    const data = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const permMsg = JSON.parse(data.trim())
    expect(permMsg.type).toBe('permission_response')
    expect(permMsg.behavior).toBe('allow')

    sock.end()
  })
})
