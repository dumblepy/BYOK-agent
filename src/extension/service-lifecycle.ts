export type MaybePromise<T> = T | PromiseLike<T>;

export interface DisposableLike {
  dispose(): MaybePromise<void>;
}

export interface ApplicationService {
  initialize(): MaybePromise<void>;
  dispose(): MaybePromise<void>;
}

/** Owns service-local resources and releases them in reverse registration order. */
export class DisposableStore implements DisposableLike {
  private readonly disposables: DisposableLike[] = [];
  private disposed = false;

  public add<T extends DisposableLike>(disposable: T): T {
    if (this.disposed) {
      void disposable.dispose();
      throw new Error("Cannot add a disposable after the store was disposed");
    }

    this.disposables.push(disposable);
    return disposable;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const errors: unknown[] = [];

    for (const disposable of [...this.disposables].reverse()) {
      try {
        await disposable.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    this.disposables.length = 0;

    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more disposables failed to dispose");
    }
  }
}

type ServiceState = "new" | "initializing" | "active" | "disposing" | "disposed";

/** Provides idempotent async initialization and disposal for application services. */
export abstract class ManagedService implements ApplicationService {
  private state: ServiceState = "new";
  private initializationPromise: Promise<void> | undefined;
  private disposalPromise: Promise<void> | undefined;

  public initialize(): Promise<void> {
    if (this.state === "active") {
      return Promise.resolve();
    }

    if (this.state === "initializing" && this.initializationPromise) {
      return this.initializationPromise;
    }

    if (this.state === "disposing" || this.state === "disposed") {
      return Promise.reject(new Error("Cannot initialize a disposed service"));
    }

    this.state = "initializing";
    const initializationPromise = Promise.resolve()
      .then(() => this.onInitialize())
      .then(
        () => {
          this.state = "active";
        },
        (error: unknown) => {
          this.state = "new";
          throw error;
        },
      );
    this.initializationPromise = initializationPromise;
    return initializationPromise;
  }

  public dispose(): Promise<void> {
    if (this.state === "disposed") {
      return Promise.resolve();
    }

    if (this.state === "disposing" && this.disposalPromise) {
      return this.disposalPromise;
    }

    this.state = "disposing";
    const disposalPromise = Promise.resolve(this.initializationPromise)
      .catch(() => undefined)
      .then(() => this.onDispose())
      .then(
        () => {
          this.state = "disposed";
        },
        (error: unknown) => {
          this.state = "disposed";
          throw error;
        },
      );
    this.disposalPromise = disposalPromise;
    return disposalPromise;
  }

  protected onInitialize(): MaybePromise<void> {
    return undefined;
  }

  protected onDispose(): MaybePromise<void> {
    return undefined;
  }
}

export async function disposeInReverse(services: readonly ApplicationService[]): Promise<void> {
  const errors: unknown[] = [];

  for (const service of [...services].reverse()) {
    try {
      await service.dispose();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more application services failed to dispose");
  }
}
