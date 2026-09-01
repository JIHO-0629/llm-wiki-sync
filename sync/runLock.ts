interface SyncExecutionState {
  running: boolean;
  type: string | null;
  scope: string | null;
  startedAt: number | null;
}

interface SyncExecutionResult<T> {
  started: boolean;
  value?: T;
}

export class SyncExecutionLock {
  private state: SyncExecutionState = {
    running: false,
    type: null,
    scope: null,
    startedAt: null
  };

  get snapshot(): SyncExecutionState {
    return { ...this.state };
  }

  async run<T>(type: string, scope: string, run: () => Promise<T>): Promise<SyncExecutionResult<T>> {
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
      return {
        started: true,
        value: await run()
      };
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
