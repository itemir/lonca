import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function newId(): string {
  return crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase();
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'project';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failure the API reports to the client as-is, with this status. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A runtime was positively identified as stopped or missing, rather than unreachable. */
export class RuntimeStoppedError extends Error {}

/** Runs tasks for the same key one at a time. */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Deletes a tree an agent could have made read-only, which would otherwise stop the delete
 * partway and leave files behind. Only real directories are touched: a link isn't followed.
 */
export async function removeTree(dir: string): Promise<void> {
  const makeWritable = async (current: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      await fs.promises.chmod(current, 0o700);
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => makeWritable(path.join(current, entry.name))));
  };
  const stat = await fs.promises.lstat(dir).catch(() => null);
  if (stat?.isDirectory()) await makeWritable(dir);
  await fs.promises.rm(dir, { recursive: true, force: true });
}
