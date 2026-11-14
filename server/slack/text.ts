// What Lonca posts is a Lead's reply, which a model wrote and which could say anything, so nothing
// in it may ping anyone. And what the user writes in Slack arrives in Slack's own markup, which a
// Lead should read the way the user wrote it.

const ZERO_WIDTH = '​';

interface Part {
  code: boolean;
  text: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;

/** A line that opens a fenced code block, and the fence that closes it. Backticks can't be in a backtick fence's info string. */
function opensFence(line: string): { char: string; length: number } | null {
  const open = FENCE_OPEN.exec(line);
  return open && !(open[1][0] === '`' && open[2].includes('`')) ? { char: open[1][0], length: open[1].length } : null;
}

function closesFence(line: string, fence: { char: string; length: number }): boolean {
  const close = FENCE_CLOSE.exec(line);
  return Boolean(close && close[1][0] === fence.char && close[1].length >= fence.length);
}

/** Fenced code blocks, and the prose between them. */
function fences(text: string): Part[] {
  const parts: Part[] = [];
  const add = (code: boolean, line: string) => {
    const last = parts.at(-1);
    if (last?.code === code) last.text += line;
    else parts.push({ code, text: line });
  };
  let fence: { char: string; length: number } | null = null;
  for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    const bare = line.replace(/\n$/, '');
    if (fence) {
      add(true, line);
      if (closesFence(bare, fence)) fence = null;
    } else {
      fence = opensFence(bare);
      add(Boolean(fence), line);
    }
  }
  return parts;
}

/** Code spans in prose, which can't run over a blank line. */
function spans(text: string): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const match of text.matchAll(/(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[^])+?)(?<!`)\1(?!`)/g)) {
    if (match.index > at) parts.push({ code: false, text: text.slice(at, match.index) });
    parts.push({ code: true, text: match[0] });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ code: false, text: text.slice(at) });
  return parts;
}

/**
 * `@here`, `@channel` and `@everyone`, written out, which Slack could take for the real thing. Each
 * is broken wherever it is, whatever Markdown is beside it, an address or a link included, which
 * there's no telling apart. Only a longer word, such as `@channels`, is left alone.
 */
function quietWords(text: string): string {
  return text.replace(/@(here|channel|everyone)(?![\p{L}\p{N}])/giu, `@${ZERO_WIDTH}$1`);
}

// Slack's markdown block reads its own syntax for mentions and broadcasts, `<@U…>` and `<!here>`,
// even escaped with a backslash, but shows them as text once they're written as entities.
function quietProse(text: string): string {
  return quietWords(text
    .replace(/<([!@#][^<>\n]*)>/g, '&lt;$1&gt;')
    .replace(/<(?=[!@#])/g, '&lt;')
    // A link to one, `[the team](!channel)`, which could come out as `<!channel|the team>`.
    .replace(/\]\([ \t]*<?[ \t]*(?=[!@#])/g, `]\\(${ZERO_WIDTH}`)
    .replace(/^( {0,3}\[[^\]\n]+\]:[ \t]*<?)(?=[!@#])/gm, `$1${ZERO_WIDTH}`));
}

// Code is shown as written, entities included, so there a zero-width space splits a mention
// instead, which looks the same. Only what could ping is split, so `<!DOCTYPE html>` stays as it is.
function quietCode(text: string): string {
  return quietWords(text
    .replace(/<(?=[@#]|!(?:here|channel|everyone|group|subteam)\b)/gi, `<${ZERO_WIDTH}`)
    // Code shouldn't be read as a link, but nobody would see this either way.
    .replace(/(\]\([ \t]*<?[ \t]*)(?=[!@#])/g, `$1${ZERO_WIDTH}`));
}

/** Markdown that can't mention or notify anyone, whatever's in it, and otherwise reads the same. */
export function quiet(markdown: string): string {
  return fences(markdown.replace(/\r\n?/g, '\n'))
    .flatMap((part) => (part.code ? [part] : spans(part.text)))
    .map((part) => (part.code ? quietCode(part.text) : quietProse(part.text)))
    .join('');
}

/**
 * Lonca's own secrets, should one turn up in a reply, as Lonca's link would if the user pasted it to
 * a Lead. Each run of text between spaces is also read as Slack could show it: with character
 * references such as `&#95;` read, backslash escapes taken out and percent-encoding decoded, as in a
 * link Lonca's server still takes, in any combination. If that has a secret in it, the whole run
 * goes, since that's simpler than finding exactly which characters were the secret. This is against
 * a secret turning up by accident. An agent that set out to pass on one it was given could write it
 * some other way, and could as well send it anywhere on the internet.
 */
export function redact(text: string, secrets: (string | undefined)[]): string {
  const hidden = secrets.filter((secret): secret is string => Boolean(secret && secret.length >= 8));
  if (hidden.length === 0) return text;
  return text.replace(/\S+/g, (run) => {
    let result = run;
    for (const secret of hidden) result = result.split(secret).join('[redacted]');
    const shown = asShown(result);
    return hidden.some((secret) => shown.includes(secret)) ? '[redacted]' : result;
  });
}

// HTML's names for ASCII punctuation, which Markdown reads as character references too.
const NAMED = new Map(Object.entries({
  excl: '!', quot: '"', QUOT: '"', num: '#', dollar: '$', percnt: '%', amp: '&', AMP: '&', apos: "'", lpar: '(', rpar: ')', ast: '*', midast: '*',
  plus: '+', comma: ',', period: '.', sol: '/', colon: ':', semi: ';', lt: '<', LT: '<', equals: '=', gt: '>', GT: '>', quest: '?', commat: '@',
  lsqb: '[', lbrack: '[', bsol: '\\', rsqb: ']', rbrack: ']', Hat: '^', lowbar: '_', UnderBar: '_', grave: '`', DiacriticalGrave: '`',
  lcub: '{', lbrace: '{', verbar: '|', vert: '|', VerticalLine: '|', rcub: '}', rbrace: '}',
}));

/** A run of text with what could stand for other characters read, a few times over, for one written inside another. */
function asShown(run: string): string {
  for (let pass = 0; pass < 8; pass++) {
    const next = run
      .replace(/&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));?/g, (whole, hex: string | undefined, decimal: string | undefined) => {
        const code = hex ? parseInt(hex, 16) : Number(decimal);
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      })
      .replace(/&([A-Za-z]+);/g, (whole, name: string) => NAMED.get(name) ?? whole)
      .replace(/\\([!-\/:-@\[-`{-~])/g, '$1')
      .replace(/%([0-9a-fA-F]{2})/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === run) break;
    run = next;
  }
  return run;
}

/** What a notification shows. Slack reads that field as its own markup, where &, < and > have to be entities, and bold is one asterisk. */
export function fallbackText(markdown: string, limit = 3000): string {
  const text = markdown.replace(/&(?!(?:lt|gt|amp);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  return text.length <= limit ? text : `${text.slice(0, safeCut(text, limit - 1))}…`;
}

/** What the user wrote in Slack, as they'd read it there: links, mentions and entities written out. */
export function plainText(text: string): string {
  return text
    .replace(/<([^<>\n]*)>/g, (_whole, inner: string) => {
      const bar = inner.indexOf('|');
      const target = bar < 0 ? inner : inner.slice(0, bar);
      const label = bar < 0 ? '' : inner.slice(bar + 1);
      if (target.startsWith('@')) return label ? `@${label.replace(/^@/, '')}` : target;
      if (target.startsWith('#')) return label ? `#${label.replace(/^#/, '')}` : target;
      if (target.startsWith('!')) {
        const [command, argument] = target.slice(1).split('^');
        if (command === 'date') return label || new Date(Number(argument) * 1000).toISOString();
        if (label) return label.startsWith('@') ? label : `@${label}`;
        return `@${command === 'subteam' ? argument : command}`;
      }
      const shown = target.replace(/^mailto:/, '');
      // Slack links what looks like an address, labelled with what was typed.
      if (!label || label === shown || target.replace(/^https?:\/\//, '') === label) return label || shown;
      return `${label} (${shown})`;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Where a long reply is split. A markdown block takes 12,000 characters, and messages have failed
 * at about 13,000, so a part stays well under that, with room for Lonca's own line.
 */
export const PART_LIMIT = 8000;
/** More than this, and only the start is posted, since the rest is easier to read in Lonca. */
export const MAX_PARTS = 4;
const TOO_LONG = '_This reply is too long to post in full. The rest is in Lonca._';

/** Not inside an entity, or between the two halves of a character. */
function safeCut(text: string, at: number): number {
  const entity = text.lastIndexOf('&', at);
  if (entity >= 0 && at - entity < 5) {
    const end = text.indexOf(';', entity);
    if (end >= at && /^&(?:lt|gt|amp);/.test(text.slice(entity))) at = entity;
  }
  const unit = text.charCodeAt(at - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) at--;
  return Math.max(1, at);
}

/** A line longer than a part, broken at a space where there's one in the second half. */
function cut(line: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(' ', limit);
    const at = space > limit / 2 ? space : safeCut(rest, limit);
    pieces.push(rest.slice(0, at));
    rest = rest.slice(rest[at] === ' ' ? at + 1 : at);
  }
  pieces.push(rest);
  return pieces;
}

function pack(pieces: string[], limit: number, joiner: string): string[] {
  const packed: string[] = [];
  let current: string | undefined;
  for (const piece of pieces) {
    if (current !== undefined && current.length + joiner.length + piece.length <= limit) current += joiner + piece;
    else {
      if (current !== undefined) packed.push(current);
      current = piece;
    }
  }
  if (current !== undefined) packed.push(current);
  return packed;
}

/** Paragraphs, with a fenced code block kept whole even where it has blank lines. */
function paragraphs(text: string): string[] {
  const found: string[] = [];
  let lines: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    if (!fence && !line.trim()) {
      if (lines.length) found.push(lines.join('\n'));
      lines = [];
      continue;
    }
    lines.push(line);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else {
      fence = opensFence(line);
    }
  }
  if (lines.length) found.push(lines.join('\n'));
  return found;
}

/** A paragraph too long for one part, by its lines. A code block is closed at the end of each part and opened again in the next. */
function fit(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];
  const lines = paragraph.split('\n');
  const fence = opensFence(lines[0]);
  if (fence && lines.length > 1) {
    const closing = fence.char.repeat(fence.length);
    const body = closesFence(lines.at(-1)!, fence) ? lines.slice(1, -1) : lines.slice(1);
    const room = Math.max(1, limit - lines[0].length - closing.length - 2);
    return pack(body.flatMap((line) => cut(line, room)), room, '\n').map((chunk) => `${lines[0]}\n${chunk}\n${closing}`);
  }
  return pack(lines.flatMap((line) => cut(line, limit)), limit, '\n');
}

/** Markdown in parts of at most `limit` characters, split between paragraphs where it can be. */
export function splitMarkdown(text: string, limit = PART_LIMIT): string[] {
  return pack(paragraphs(text).flatMap((paragraph) => fit(paragraph, limit)), limit, '\n\n');
}

/** A Lead's reply, already made quiet, as the messages to post, with Lonca's own line at the end. */
export function replyParts(reply: string, note?: string): string[] {
  let parts = reply.trim() ? splitMarkdown(reply.trim()) : [];
  if (parts.length > MAX_PARTS) parts = [`${parts[0]}\n\n${TOO_LONG}`];
  if (!note) return parts;
  if (parts.length === 0) return [note];
  parts[parts.length - 1] += `\n\n${note}`;
  return parts;
}
