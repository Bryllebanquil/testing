import { wsClient } from '../services/websocket';

type QueueEvent =
  | 'ack'
  | 'success'
  | 'error'
  | 'timeout';

export interface PendingCommand {
  local_id: string;
  agent_id: string;
  command: string;
  issued_at: number;
  expires_at: number;
  status: 'pending' | 'success' | 'error' | 'timeout';
  execution_id?: string;
}

export type SendFn = (agentId: string, command: string) => Promise<void> | void;

export class CommandQueue {
  private pending: Map<string, PendingCommand> = new Map();
  private timers: Map<string, number> = new Map();
  private listeners: Map<QueueEvent, Set<(pc: PendingCommand) => void>> = new Map();
  private sendFn: SendFn;
  private ttlMs: number;

  constructor(sendFn: SendFn, ttlMs = 15000) {
    this.sendFn = sendFn;
    this.ttlMs = ttlMs;
    wsClient.on('command_result', (data: any) => {
      try {
        const agentId = String(data?.agent_id || '');
        const cmd = String(data?.command || '');
        // Find the earliest matching pending entry for this agent+command
        const match = [...this.pending.values()]
          .filter(p => p.agent_id === agentId && p.command === cmd && p.status === 'pending')
          .sort((a, b) => a.issued_at - b.issued_at)[0];
        if (match) {
          match.status = data?.success ? 'success' : 'error';
          match.execution_id = String(data?.execution_id || '');
          this.clearTimer(match.local_id);
          this.emit(match.status, match);
          this.pending.delete(match.local_id);
        }
      } catch {}
    });
  }

  on(event: QueueEvent, handler: (pc: PendingCommand) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: QueueEvent, handler: (pc: PendingCommand) => void): void {
    const set = this.listeners.get(event);
    if (set) set.delete(handler);
  }

  enqueue(agentId: string, command: string): PendingCommand {
    const now = Date.now();
    const localId = `local_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const pc: PendingCommand = {
      local_id: localId,
      agent_id: agentId,
      command,
      issued_at: now,
      expires_at: now + this.ttlMs,
      status: 'pending'
    };
    this.pending.set(localId, pc);
    // Immediate ACK to UI
    this.emit('ack', pc);
    // Start timeout
    this.startTimer(localId, this.ttlMs);
    // Fire command
    Promise.resolve()
      .then(() => this.sendFn(agentId, command))
      .catch(() => {
        const curr = this.pending.get(localId);
        if (curr && curr.status === 'pending') {
          curr.status = 'error';
          this.clearTimer(localId);
          this.emit('error', curr);
          this.pending.delete(localId);
        }
      });
    return pc;
  }

  enqueueBatch(agentId: string, commands: string[]): PendingCommand[] {
    const results: PendingCommand[] = [];
    for (const c of commands) {
      const cmd = c.trim();
      if (!cmd) continue;
      results.push(this.enqueue(agentId, cmd));
    }
    return results;
  }

  getPending(): PendingCommand[] {
    return [...this.pending.values()].sort((a, b) => a.issued_at - b.issued_at);
  }

  private startTimer(localId: string, ms: number): void {
    const t = window.setTimeout(() => {
      const curr = this.pending.get(localId);
      if (curr && curr.status === 'pending') {
        curr.status = 'timeout';
        this.emit('timeout', curr);
        this.pending.delete(localId);
      }
      this.timers.delete(localId);
    }, ms);
    this.timers.set(localId, t);
  }

  private clearTimer(localId: string): void {
    const t = this.timers.get(localId);
    if (t) {
      window.clearTimeout(t);
      this.timers.delete(localId);
    }
  }

  private emit(event: QueueEvent, pc: PendingCommand): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        try { fn(pc); } catch {}
      }
    }
  }
}

export default CommandQueue;
