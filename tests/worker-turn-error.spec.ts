/** Native DSH turn failures must not leave an assignment running. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, runningAssignment, waitsForPerson } from '../src/core/index.ts'
import { canRetry, ticketStage } from '../src/core/stage.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

function turnEnd(sessionId: string, reason: object) {
  const agent = h.agents.get(sessionId)! as unknown as { session: never }
  h.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 0, reason } } as never)
}
const failure = { kind: 'error', error: { code: 'INVALID_REQUEST', message: 'Invalid tool schema' } }

describe('native worker turn/end error', () => {
  it('handles a first-turn failure before launch delivery acknowledges assignmentStarted', async () => {
    const create = h.controller.create.getMockImplementation()!
    let pendingAtFailure = false
    h.controller.create.mockImplementation(async options => {
      await create(options)
      if (!options.sessionId.startsWith('worker-')) return
      const agent = h.agents.get(options.sessionId)!, followup = agent.followup.getMockImplementation()!
      agent.followup.mockImplementation(message => {
        followup(message)
        pendingAtFailure = latestAssignment(h.runtime.store.tickets.get(options.sessionId.slice('worker-'.length))!)?.state === 'pending'
        turnEnd(options.sessionId, failure)
      })
    })
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    expect(pendingAtFailure).toBe(true)
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!))
      .toMatchObject({ state: 'ended', endedReason: 'error', report: { state: 'failed' } }))
  })

  it.each([failure, { kind: 'error', error: { code: 'SERVER_ERROR', message: 'Service Unavailable', status: 503 } }])(
    'ends the first assignment and leaves the ticket explicitly retryable (%j)', async reason => {
      const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
      const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
      turnEnd(one.sessionId, reason)
      await vi.waitFor(() => expect(latestAssignment(ticket())).toMatchObject({ state: 'ended', endedReason: 'error',
        endedAt: expect.any(String), report: { state: 'failed', summary: expect.stringContaining(reason.error.message) } }))
      expect(runningAssignment(ticket())).toBeUndefined()
      expect(canRetry(ticket())).toBe(true)
      expect(ticketStage(ticket())).toEqual({ stage: 'person', action: 'failed' })
      expect(waitsForPerson(ticket())).toBe(true)
      await h.runtime.idle()
      expect(h.runtime.executor.activeCount()).toBe(0)
      expect(h.deliveries.mock.calls.filter(([call]) => call.sessionId === h.runtime.masterId && call.text.includes(reason.error.message))).toHaveLength(1)
    })

  it('does not overwrite the error on idle or duplicate notification, and retries into a new assignment', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const original = latestAssignment(ticket())!.id
    turnEnd(one.sessionId, failure)
    turnEnd(one.sessionId, failure)
    h.ctx.emit('agent/error', { agent: h.agents.get(one.sessionId), turn: 0, step: 0, error: new Error(failure.error.message) } as never)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.state).toBe('ended'))
    await h.runtime.idle()
    const ended = latestAssignment(ticket())!
    h.runtime.executor.resume()
    await h.runtime.idle()
    expect(ticket().assignments).toEqual([ended])
    h.runtime.engine.retryTicket(one.ticket.id)
    await h.runtime.idle()
    expect(ticket().assignments[0]).toEqual(ended)
    expect(latestAssignment(ticket())).toMatchObject({ state: 'running' })
    expect(latestAssignment(ticket())!.id).not.toBe(original)
    // Replaying the old Session event must not fail the replacement assignment.
    turnEnd(one.sessionId, failure)
    await h.runtime.idle()
    expect(latestAssignment(ticket())).toMatchObject({ state: 'running' })
  })

  it('relays once when agent/error arrives before the native terminal event', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.ctx.emit('agent/error', { agent: h.agents.get(one.sessionId), turn: 0, step: 0, error: new Error(failure.error.message) } as never)
    turnEnd(one.sessionId, failure)
    await h.runtime.idle()
    expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)).toMatchObject({ state: 'ended', endedReason: 'error' })
    expect(h.deliveries.mock.calls.filter(([call]) => call.sessionId === h.runtime.masterId && call.text.includes(failure.error.message))).toHaveLength(1)
  })

  it('holds automated input after failure but starts a new assignment for a human follow-up', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    turnEnd(one.sessionId, failure)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.state).toBe('ended'))
    await h.runtime.idle()
    h.runtime.receive(feishu('2', 'CI failed', { mentions: [], root_id: 'om_1', sender_id: 'cli_ci', sender_type: 'bot' }))
    await h.runtime.idle()
    expect(ticket().assignments).toHaveLength(1)
    expect(waitsForPerson(ticket())).toBe(true)
    h.runtime.receive(feishu('3', '请继续修复', { mentions: [], root_id: 'om_1' }))
    await h.runtime.idle()
    expect(ticket().assignments).toHaveLength(2)
    expect(ticket().assignments[0]).toMatchObject({ state: 'ended', endedReason: 'error' })
    expect(latestAssignment(ticket())).toMatchObject({ state: 'running' })
    expect(ticket().undelivered).toEqual([])
  })

  it.each(['completed', 'aborted', 'blocked'])('does not classify a %s turn as an error', async kind => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    turnEnd(one.sessionId, { kind, ...(kind === 'aborted' ? { reason: { kind: 'user' } } : {}) })
    await h.runtime.idle()
    expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)).toMatchObject({ state: 'running' })
  })

  it('ignores errors on the main Session and while shutting down', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    turnEnd(h.runtime.masterId, failure)
    await h.runtime.idle()
    expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toBeUndefined()
    const stopping = h.runtime.stop()
    turnEnd(one.sessionId, failure)
    await stopping
    // The store is closed by stop; no error report was relayed during shutdown.
    expect(h.deliveries.mock.calls.some(([call]) => call.text.includes(failure.error.message))).toBe(false)
  })
})
