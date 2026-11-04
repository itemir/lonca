import { EventEmitter } from 'node:events';
import type { ServerEvent } from '../shared/types.ts';

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(event: ServerEvent): void {
  bus.emit('event', event);
}

export function subscribe(listener: (event: ServerEvent) => void): () => void {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
