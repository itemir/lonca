import fs from 'node:fs';
import type { Playbook, Project } from '../../shared/types.ts';
import { paths } from '../config.ts';
import { writeAtomic } from '../store.ts';

const TEMPLATE = fs.readFileSync(new URL('./lead-template.md', import.meta.url), 'utf8');

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('could not read a playbook:', error);
    return null;
  }
}

function file(project: Project | undefined): string {
  return project ? paths.projectPlaybook(project.slug) : paths.playbook;
}

/** A project's own file replaces the global one rather than adding to it. */
export function playbookFor(project: Project | undefined): Playbook {
  const own = project && read(paths.projectPlaybook(project.slug));
  if (own) return { content: own, source: 'project', template: TEMPLATE };
  const global = read(paths.playbook);
  return global ? { content: global, source: 'global', template: TEMPLATE } : { content: TEMPLATE, source: 'template', template: TEMPLATE };
}

export function savePlaybook(project: Project | undefined, content: string): void {
  writeAtomic(file(project), content, 0o600);
}

export function resetPlaybook(project: Project | undefined): void {
  fs.rmSync(file(project), { force: true });
}
