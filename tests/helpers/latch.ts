import { prisma } from '../../src/db/prisma';
import { createBarrier, type Barrier } from './barrier';

/**
 * Deterministic race reproduction needs a request pinned at an exact point in
 * its lifecycle. Spying on Prisma delegate methods is not viable: those
 * properties are lazy getters, and Vitest's restore leaves them `undefined`,
 * corrupting the client for every later test. Prisma's own `$use` middleware is
 * the supported interception point, so the latch is implemented there. It is
 * registered once and stays completely inert unless a test arms it.
 */
interface Latch {
  model: string;
  action: string;
  consumed: boolean;
  reached: Barrier;
  resume: Barrier;
}

let active: Latch | null = null;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;

  (prisma as any).$use(async (params: any, next: any) => {
    const result = await next(params);

    const latch = active;
    if (latch && !latch.consumed && params.model === latch.model && params.action === latch.action) {
      latch.consumed = true;
      latch.reached.release();
      await latch.resume.promise;
    }

    return result;
  });
}

export interface QueryLatch {
  /** Resolves once the targeted query has run and its caller is parked. */
  reached: Promise<void>;
  /** Lets the parked caller continue. */
  release: () => void;
  /** Disarms the latch and unparks anything still waiting. */
  disarm: () => void;
}

/**
 * Parks the next query matching `model`.`action` immediately after it returns,
 * leaving its caller holding a deliberately stale read.
 */
export function armQueryLatch(model: string, action: string): QueryLatch {
  install();

  const latch: Latch = {
    model,
    action,
    consumed: false,
    reached: createBarrier(),
    resume: createBarrier(),
  };
  active = latch;

  return {
    reached: latch.reached.promise,
    release: () => latch.resume.release(),
    disarm: () => {
      if (active === latch) active = null;
      latch.resume.release();
    },
  };
}

export function disarmAllLatches(): void {
  if (active) {
    active.resume.release();
    active = null;
  }
}
