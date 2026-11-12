// Every error and warning Lonca prints says when it happened, so it can be matched with what else
// was going on, such as the computer going to sleep. The server imports this before anything else.

const pad = (value: number) => String(value).padStart(2, '0');

/** In this computer's time, which is what someone reading the log will compare it with. */
function now(): string {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

for (const level of ['error', 'warn'] as const) {
  const write = console[level].bind(console);
  // Joined to a message rather than put before it, where it would become the message's format.
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === 'string') write(`${now()} ${args[0]}`, ...args.slice(1));
    else write(now(), ...args);
  };
}
