const jobs = new Map<string, () => void>();

export function beginJob(id: string, cancel: () => void): void {
  jobs.set(id, cancel);
}

export function finishJob(id: string): void {
  jobs.delete(id);
}

export function cancelJob(id: string): void {
  jobs.get(id)?.();
}
