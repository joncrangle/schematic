/** Agencies sharing an upstream host would otherwise open every request at once. */
export interface HostConcurrencyLimiter {
  /** Runs `task` once its host has a free slot. The slot is released when it settles. */
  readonly run: <T>(url: string, task: () => Promise<T>) => Promise<T>;
}

interface HostSlots {
  active: number;
  readonly waiting: (() => void)[];
}

function hostKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

export function createHostConcurrencyLimiter(limit: number): HostConcurrencyLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Host concurrency limit must be a positive integer");
  }
  const hosts = new Map<string, HostSlots>();

  const acquire = async (host: string): Promise<HostSlots> => {
    let slots = hosts.get(host);
    if (slots === undefined) {
      slots = { active: 0, waiting: [] };
      hosts.set(host, slots);
    }
    if (slots.active < limit) {
      slots.active += 1;
      return slots;
    }
    const queued = slots;
    // A released slot passes straight to the next waiter.
    await new Promise<void>((resolve) => queued.waiting.push(resolve));
    return queued;
  };

  const release = (host: string, slots: HostSlots) => {
    const next = slots.waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }
    slots.active -= 1;
    if (slots.active === 0) hosts.delete(host);
  };

  return {
    run: async (url, task) => {
      const host = hostKey(url);
      const slots = await acquire(host);
      try {
        return await task();
      } finally {
        release(host, slots);
      }
    },
  };
}
