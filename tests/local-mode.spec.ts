/** A Feishu-only installation (local mode): setup completes without a GitHub repository, work dispatches, and Feishu events arrive. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { feishuKind, feishuTriggerId } from '../src/sources/feishu.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import { CHAT, feishu, MEMBER, startRuntime } from './fixtures/host.ts'

/** A group message to the bot in the listened chat, as the live event consumer prints it. */
const liveEvent = () => ({ message_id: 'om_live_1', chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
  content: '修复登录页', create_time: '1790000000000', mentions: [{ id: 'ou_bot', name: 'Bot' }] })

it('configures and dispatches from the Feishu Source alone, with no GitHub repository', async () => {
  const h = await startRuntime(undefined, { local: true })
  try {
    // Setup resolved local mode: no repository, no agent account, no setup problem, and the runtime is not held paused.
    expect(h.runtime.setupProblem).toBeUndefined()
    expect(h.runtime.feishuProblem).toBeUndefined()
    expect(h.runtime.configured()).toBe(true)
    expect(h.runtime.deployment).toMatchObject({ repository: '' })
    expect(h.runtime.deployment.github).toBeUndefined()
    expect(h.runtime.deployment.feishu).toMatchObject({ botId: 'ou_bot' })
    expect(h.runtime.health.runtime).toMatchObject({ state: 'ready' })

    // Not paused: a Feishu trigger is assessed, so its candidate card reaches the main Session.
    const trigger = feishu('1', '@bot 修复登录页')
    h.runtime.receive(trigger)
    await h.runtime.idle()
    expect(h.candidates()).toContain(trigger.id)

    // A ticket accepted there takes a Chinese name with spaces as its directory and needs no pull request.
    const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: '修复登录页',
      worktree_name: '修复 登录 页', acknowledgement: '收到，修复登录页。' })
    await h.runtime.pump(); await h.runtime.idle()
    const ticket = h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    expect(ticket.execution?.name.startsWith('修复-登录-页-')).toBe(true)
    expect(ticket.execution?.directory.endsWith(ticket.execution!.name)).toBe(true)
    // The assignment states the deliverable local mode can meet, so the worker does not wait for a pull request.
    expect(ticket.execution!.assignment).toContain('no GitHub repository')

    const session = `worker-${ticket.id}`
    // Local mode has no repository, so a report cannot claim a pull request; the work reports itself instead.
    await expect(h.runTool(session, 'orchestrator_report', { state: 'ready', summary: '完成', pr_number: 1 }))
      .rejects.toThrow('no GitHub repository')
    await h.runTool(session, 'orchestrator_report', { state: 'ready', summary: '登录页已修复' })
    // A ready report without followed pull requests ends the ticket as completed, and reaches the main Session as its result.
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'completed' })
    await h.runtime.pump(); await h.runtime.idle(); await h.runtime.effects.idle()
    expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'worker_report', state: 'ready' }))

    // The Feishu Source itself runs: its event consumer starts on the resolved bot and ingests a live event.
    const scratch = mkdtempSync(join(tmpdir(), 'feishu-local-'))
    try {
      const events = join(scratch, 'events')
      writeFileSync(events, `${JSON.stringify(liveEvent())}\n`)
      writeFileSync(h.bot, `#!/bin/sh\n[ "$1" = event ] || exit 0\necho '[event] ready' >&2\ncat '${events}'\nexec sleep 300\n`, { mode: 0o755 })
      const controller = new AbortController()
      const running = runFeishu(h.runtime.context(feishuKind), controller.signal)
      await vi.waitFor(() => expect(h.runtime.store.triggers.get(feishuTriggerId('om_live_1'))).toBeDefined(), { timeout: 10_000 })
      expect(h.runtime.health.feishu).toMatchObject({ state: 'ready', detail: 'Listening for bot events' })
      controller.abort()
      await running
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  } finally { await h.stop() }
})
