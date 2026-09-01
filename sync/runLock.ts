export interface SyncExecutionSnapshot {
  running: boolean;
  type: string | null;
  scope: string | null;
  startedAt: number | null;
}

export class SyncExecutionLock {
  private state: SyncExecutionSnapshot = {
    running: false,
    type: null,
    scope: null,
    startedAt: null
  };

  get snapshot(): SyncExecutionSnapshot {
    return { ...this.state };
  }

  async run<T>(type: string, scope: string, callback: () => Promise<T>): Promise<{ started: true; value: T } | { started: false }> {
    if (this.state.running) {
      return { started: false };
    }

    this.state = {
      running: true,
      type,
      scope,
      startedAt: Date.now()
    };
    try {
      return { started: true, value: await callback() };
    } finally {
      this.state = {
        running: false,
        type: null,
        scope: null,
        startedAt: null
      };
    }
  }
}
