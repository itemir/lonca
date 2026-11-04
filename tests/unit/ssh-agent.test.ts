import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { emptyAgent, emptyAgentReply } from '../../server/ssh-agent.ts';

/** Sends one SSH agent request and returns the reply's type and body. */
function ask(socket: string, type: number, body = Buffer.alloc(0)): Promise<{ type: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    let received = Buffer.alloc(0);
    connection.on('error', reject);
    connection.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 4 && received.length >= 4 + received.readUInt32BE(0)) {
        connection.end();
        resolve({ type: received[4], body: received.subarray(5, 4 + received.readUInt32BE(0)) });
      }
    });
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length + 1);
    connection.write(Buffer.concat([length, Buffer.from([type]), body]));
  });
}

describe('the SSH agent Lonca gives sandboxes', () => {
  it('lists no keys and signs nothing', async () => {
    const socket = await emptyAgent();
    expect(socket).toBeTruthy();
    const identities = await ask(socket, 11);
    expect(identities.type).toBe(12);
    expect(identities.body.readUInt32BE(0)).toBe(0);
    expect((await ask(socket, 13, Buffer.from('a key and some data'))).type).toBe(5);
    expect((await ask(socket, 17, Buffer.from('a key to add'))).type).toBe(5);
  });

  it('is one agent, however often it’s asked for', async () => {
    expect(await emptyAgent()).toBe(await emptyAgent());
  });

  it('answers each request in a message on its own', () => {
    expect([...emptyAgentReply(11)]).toEqual([0, 0, 0, 5, 12, 0, 0, 0, 0]);
    expect([...emptyAgentReply(13)]).toEqual([0, 0, 0, 1, 5]);
  });
});
