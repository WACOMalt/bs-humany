/**
 * The echo of the headset's commands on the terminal, one line a slider drag rather than one a
 * command.
 *
 * Every command the panel sends is still applied, one by one; this is only what is said of them.
 * The echo used to go through the studio's status line as well as the terminal, a line a command,
 * and a drive slider dragged for two seconds sends a few dozen: the status line flickered through
 * them and lost whatever it had been saying, and the terminal filled with forty lines that said
 * one thing. Now the first command of a drag is said at once, the rest of it are counted, and the
 * last of it is said with the count once the drag ends -- when the panel moves on to something
 * else, or a poll comes back with nothing, which is the headset having let go.
 *
 * Pure, with no Tauri in it, so it runs in the tests; `VrLink` feeds it a poll at a time and hands
 * what it says to the host's `trace`.
 */

import type { PanelCommand } from '@bs-humany/pose-bridge/codec';

/** One command as it came off the log: the line as written, and what it parsed to. */
export interface EchoedCommand {
  readonly line: string;
  readonly command: PanelCommand;
}

/**
 * What a command moves: its kind, and which drive group or which setting. Two commands with the
 * same target are one gesture's; a command for anything else ends that gesture.
 */
function targetOf(command: PanelCommand): string {
  switch (command.kind) {
    case 'drive':
      return `drive:${command.group}`;
    case 'set':
      return `set:${command.key}`;
    default:
      return command.kind;
  }
}

export class PanelEcho {
  /** The target of the run being merged, or undefined with none. */
  private pending: string | undefined;
  /** The newest line of that run, the one said when it ends. */
  private pendingLine = '';
  /** How many of the run came after the one said at once. */
  private count = 0;

  constructor(private readonly trace: (message: string) => void) {}

  /**
   * One poll's commands, in the order they were sent. An empty poll ends any run, as the panel
   * has sent nothing for one poll's interval.
   */
  batch(commands: readonly EchoedCommand[]): void {
    if (commands.length === 0) {
      this.flush();
      return;
    }
    for (const { line, command } of commands) {
      const target = targetOf(command);
      if (target === this.pending) {
        this.pendingLine = line;
        this.count += 1;
        continue;
      }
      this.flush();
      this.trace(`VR panel: ${line}`);
      this.pending = target;
      this.pendingLine = line;
    }
  }

  /**
   * End the run being merged: say its last line with how many were not said, when there were any,
   * and start afresh, so the next command for the same target is said at once.
   */
  flush(): void {
    if (this.count > 0) this.trace(`VR panel: ${this.pendingLine} (and ${this.count} more)`);
    this.pending = undefined;
    this.pendingLine = '';
    this.count = 0;
  }
}
