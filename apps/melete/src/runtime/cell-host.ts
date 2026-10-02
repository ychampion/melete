/**
 * Where attempt cells run: an engine that creates each cell's network, home
 * volume and container, with the job's workspace mounted at /work.
 *
 * The attempt supervisor (`DockerHermesRuntimeAdapter`) decides what runs and
 * when: attempts, spares and their hand-off. A `CellHost` only provisions,
 * reconciles and removes cells on one engine. `LocalCellHost` is the engine
 * the service itself runs on.
 */

/** A cell for one attempt of a job, or a spare engine loaded ahead of its attempt. */
export type CellSpec = {
  cell: { attempt: string; job: string } | { spare: string };
  /** The container's whole environment. */
  environment: string[];
};

export type CellState = { status?: string; exitCode?: number };

/**
 * One cell on its host. Nothing exists until `start`; whatever `start` created
 * stays until `release`, also when `start` failed part way, so the caller
 * removes it in one place whatever happened.
 */
export type CellHandle = {
  /** How the cell reaches the broker: as `melete` on its own network, or through a gateway. */
  brokerPeer: 'local-network' | 'gateway';
  /**
   * Creates the cell's workspace directory, network, home and container and
   * starts it; returns where its engine API answers, from the service.
   */
  start(signal: AbortSignal): Promise<string>;
  /** The container's state as its engine reports it. */
  state(): Promise<CellState>;
  /**
   * For a spare: makes its workspace the job's, with what the job already had,
   * before the attempt is handed to it. Spares need the job's workspace on the
   * cell's own host; a host that cannot do that refuses, and the attempt
   * starts a cell of its own.
   */
  adopt(job: string): Promise<void>;
  /** For a spare: gives its container the name a cold engine for this attempt would have. */
  rename(attempt: string): Promise<void>;
  /** Removes the container, network and home, and a spare's directory no attempt took. */
  release(): Promise<void>;
};

export interface CellHost {
  /** 'local', or 'remote:<name>'. */
  readonly id: string;
  /** Checks the host and pins the engine image; called once before anything else. */
  verify(): Promise<{ engine: string; imageId: string }>;
  /**
   * Removes cells and workspace leftovers no running attempt owns: at a start,
   * this instance's own and those of instances that stopped; later, only the latter.
   */
  reconcile(scope: 'start' | 'stopped'): Promise<void>;
  /** A cell for this spec, not yet created: see `CellHandle.start`. */
  cell(spec: CellSpec): CellHandle;
}
