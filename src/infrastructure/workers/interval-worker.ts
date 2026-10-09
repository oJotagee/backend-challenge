export interface WorkerLogger {
  error(obj: object, msg: string): void;
}

/**
 * Executa `tick` em loop. Se o tick encontrou trabalho, roda de novo na hora (drena a fila);
 * se não, espera `intervalMs`. `stop()` espera o tick em andamento terminar.
 */
export class IntervalWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: WorkerLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let hadWork = false;
      try {
        hadWork = await this.tick();
      } catch (error) {
        this.logger.error({ err: error, worker: this.name }, 'worker tick failed');
      }
      if (!hadWork && this.running) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          setTimeout(resolve, this.intervalMs);
        });
      }
    }
  }
}
