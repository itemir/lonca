import { execFile } from 'node:child_process';
import { state } from './store.ts';

// The computer's own notifications, so they arrive with the browser closed too.

const focused = new Set<object>();

export function setClientFocus(client: object, isFocused: boolean): void {
  if (isFocused) focused.add(client);
  else focused.delete(client);
}

export function notificationCommand(platform: NodeJS.Platform, title: string, text: string): [string, string[]] | null {
  // Passed as arguments, so nothing in the text can become AppleScript.
  if (platform === 'darwin') return ['osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text]];
  if (platform === 'linux') return ['notify-send', ['--', title, text]];
  return null;
}

/** Tells someone who isn't looking at Lonca. Only fixed wording and a workspace's name go in `text`. */
export function notifyUser(text: string): void {
  if (!state.settings.notifications || focused.size > 0 || process.env.LONCA_NO_NOTIFY === '1') return;
  const command = notificationCommand(process.platform, 'Lonca', text);
  if (command) execFile(command[0], command[1], { timeout: 10000 }, () => {});
}
