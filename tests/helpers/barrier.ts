/**
 * A one-shot latch used to pin a request at a precise point in its lifecycle so
 * a race can be reproduced deterministically instead of hopefully.
 */
export interface Barrier {
  promise: Promise<void>;
  release: () => void;
}

export function createBarrier(): Barrier {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
