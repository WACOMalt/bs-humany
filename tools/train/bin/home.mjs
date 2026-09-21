/**
 * Where bs-humany keeps what a person makes with it.
 *
 * One directory, the one the operating system means for this, so the command-line trainer, the
 * dashboard and the studio binary all read and write the same checkpoints. Before this the
 * trainer wrote into the repository and the binary wrote into its own reverse-DNS corner of the
 * data directory, which meant a checkpoint trained one way was invisible the other way.
 *
 *   Linux    $XDG_DATA_HOME/bs-humany, or ~/.local/share/bs-humany
 *   macOS    ~/Library/Application Support/bs-humany
 *   Windows  %APPDATA%\bs-humany
 *
 * Named for the project rather than for a bundle identifier, because a person who wants to copy
 * a policy onto another machine, or keep one, or delete one, has to be able to find it. The
 * Rust side computes the same path; they are kept in step by a test.
 *
 * `BS_HUMANY_HOME` overrides all of it, for a run that wants its own.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** The root, made if it is not there. */
export function dataHome() {
  const override = process.env.BS_HUMANY_HOME;
  if (override) return override;
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'bs-humany');
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'bs-humany');
  }
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'bs-humany');
}

/** Where the checkpoints live. */
export function policiesDir() {
  const dir = join(dataHome(), 'policies');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where a run's history and its centre live. */
export function runsDir() {
  const dir = join(dataHome(), 'runs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Copy the checkpoints that ship with the repository into the data directory, once, if it has
 * none of its own. A fresh machine then has something to hand a body without training first,
 * and a person who deletes one does not get it back the next time they start the trainer.
 */
export function seedFromRepository(repositoryPolicies) {
  const dir = policiesDir();
  const marker = join(dataHome(), '.seeded');
  if (existsSync(marker)) return dir;
  try {
    if (existsSync(repositoryPolicies)) {
      for (const name of readdirSync(repositoryPolicies)) {
        if (!name.endsWith('.json')) continue;
        const to = join(dir, name);
        if (!existsSync(to)) copyFileSync(join(repositoryPolicies, name), to);
      }
    }
    // Written whether or not there was anything to copy, so this happens once either way.
    writeFileSync(
      marker,
      'The checkpoints that shipped with bs-humany were copied into ./policies once, when this\n' +
        'file was written. Delete this file to have them copied again; delete a policy and it\n' +
        'stays deleted.\n',
    );
  } catch {
    // A read-only or missing repository is not a reason to refuse to train.
  }
  return dir;
}
