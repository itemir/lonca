import { describe, expect, it } from 'vitest';
import { SLACK_MANIFEST, SLACK_SCOPES } from '../../shared/slack.ts';
import { MAX_PARTS, PART_LIMIT, fallbackText, plainText, quiet, redact, replyParts, splitMarkdown } from '../../server/slack/text.ts';

const ZW = '​';

// Anything Slack could read as a mention or a broadcast: its own syntax, and the words written out,
// which mustn't be left in what's posted at all.
const SLACK_SYNTAX = /<[!@#]/;
const BROADCAST_WORDS = /@(here|channel|everyone)/i;
const MENTION_LINK = /\]\([ \t]*<?[ \t]*[!@#]/;

const PINGS = [
  '<!here>', '<!channel>', '<!everyone>', '<!here|here>', '<!subteam^S0123ABC|@devs>', '<!subteam^S0123ABC>', '<@U0123ABCD>', '<@W0123ABCD|bob>',
  '<#C0123ABCD>', '<#C0123ABCD|general>', '<!here', '@here', '@channel', '@everyone', '@Here', '[the team](!channel)', '[owner](@U0123ABCD)',
  '[x]( <!here> )', '[x](#C0123ABCD)', '\\<!here\\>',
];

// Where in a reply each could be.
const PLACES = [
  (ping: string) => ping,
  (ping: string) => `Done. ${ping} please look.`,
  (ping: string) => `**${ping}**`,
  (ping: string) => `_${ping}_`,
  (ping: string) => `*${ping}*`,
  (ping: string) => `~${ping}~`,
  (ping: string) => `__${ping}__`,
  (ping: string) => `**_${ping}_**`,
  (ping: string) => `${ping}_ and _${ping}`,
  (ping: string) => `(${ping})`,
  (ping: string) => `> ${ping}`,
  (ping: string) => `- one\n- ${ping}`,
  (ping: string) => `| a | b |\n| --- | --- |\n| ${ping} | x |`,
  (ping: string) => `\`${ping}\``,
  (ping: string) => `\`\`${ping}\`\``,
  (ping: string) => `\`\`\`\n${ping}\n\`\`\``,
  (ping: string) => `~~~sh\necho ${ping}\n~~~`,
  (ping: string) => `\`\`\`\nunclosed ${ping}`,
  (ping: string) => `[label](https://example.com) ${ping}`,
];

describe('making a reply safe to post', () => {
  it.each(PINGS)('leaves nothing that could ping in %s, wherever it is', (ping) => {
    for (const place of PLACES) {
      const safe = quiet(place(ping));
      expect(safe, place(ping)).not.toMatch(SLACK_SYNTAX);
      expect(safe, place(ping)).not.toMatch(BROADCAST_WORDS);
      expect(safe, place(ping)).not.toMatch(MENTION_LINK);
    }
  });

  it('writes Slack’s syntax out as entities in prose, which the markdown block shows as text', () => {
    expect(quiet('Tell <!here> and <@U0123ABCD|bob> in <#C0123ABCD>.')).toBe('Tell &lt;!here&gt; and &lt;@U0123ABCD|bob&gt; in &lt;#C0123ABCD&gt;.');
  });

  it('splits a mention in code, where entities would show as themselves, and leaves the rest of the code alone', () => {
    const code = '```html\n<!DOCTYPE html>\n<!-- a comment -->\n<p>@channel <@U0123ABCD></p>\n```';
    expect(quiet(code)).toBe(`\`\`\`html\n<!DOCTYPE html>\n<!-- a comment -->\n<p>@${ZW}channel <${ZW}@U0123ABCD></p>\n\`\`\``);
    expect(quiet('Run `echo <!here>`')).toBe(`Run \`echo <${ZW}!here>\``);
  });

  it('keeps a link to a mention from being one', () => {
    expect(quiet('Ask [the team](!channel) or [bob](@U0123ABCD).')).toBe(`Ask [the team]\\(${ZW}!channel) or [bob]\\(${ZW}@U0123ABCD).`);
    expect(quiet('[team]: !here')).toBe(`[team]: ${ZW}!here`);
  });

  it('breaks @here, @channel and @everyone wherever they are, whatever Markdown is beside them', () => {
    expect(quiet('Ping _@here_, *@channel*, ~@everyone~ and __@Here__.')).toBe(`Ping _@${ZW}here_, *@${ZW}channel*, ~@${ZW}everyone~ and __@${ZW}Here__.`);
    // Even in an address or a link, which there's no telling from Markdown.
    expect(quiet('bob@here.com and https://example.com/@channel')).toBe(`bob@${ZW}here.com and https://example.com/@${ZW}channel`);
    // Other words that start the same are left alone.
    expect(quiet('@heretic and @channels')).toBe('@heretic and @channels');
  });

  it('leaves everything else as the Lead wrote it', () => {
    const text = [
      '# Plan', '', '**Bold**, _italic_, ~~gone~~ and `code`.', '', '> a < b && c > d, Vec<String>, x->y', '',
      '- [link](https://example.com/?a=1&b=2)', '- bob@example.com, https://example.com/@team', '', '| a | b |', '| --- | --- |', '| 1 | 2 |',
    ].join('\n');
    expect(quiet(text)).toBe(text);
  });

  it('takes out a secret written percent-encoded, as in a link Lonca’s server would still take', () => {
    const token = 'abcdefghijklmnopqrstuvwx';
    const encoded = [...token].map((character) => `%${character.charCodeAt(0).toString(16)}`).join('');
    expect(redact(`Open http://localhost:4700/?token=${encoded} now`, [token])).toBe('Open [redacted] now');
    const link = redact('See [Lonca](http://localhost:4700/?x=1&token=abc%64efghijklmnopqrstuvwx).', [token]);
    expect(link).toBe('See [redacted]');
    expect(redact('100% sure that a%20b and %zz are fine', [token])).toBe('100% sure that a%20b and %zz are fine');
  });

  it('takes out a secret written with character references or backslash escapes, which Slack would show as the secret', () => {
    const token = 'abc_def-ghijklmnopqrstuvwx';
    const written = [
      'abc&#95;def-ghijklmnopqrstuvwx', 'abc&#x5F;def&#X2d;ghijklmnopqrstuvwx', 'abc&lowbar;def-ghijklmnopqrstuvwx', '&#97;bc_def-ghijklmnopqrstuvwx',
      'abc\\_def\\-ghijklmnopqrstuvwx', 'abc_def-ghijklmnopqrstuvw&#120',
      // Combined, as one inside another.
      'abc&#37;5Fdef-ghijklmnopqrstuvwx', 'abc%26%2395%3Bdef-ghijklmnopqrstuvwx', 'abc&amp;#95;def-ghijklmnopqrstuvwx', 'abc&bsol;_def\\%2Dghijklmnopqrstuvwx',
    ];
    for (const text of written) expect(redact(`Use ${text} here.`, [token])).toBe('Use [redacted] here.');
    expect(redact(`See [Lonca](http://localhost:4700/?token=abc&#95;def-ghijklmnopqrstuvwx).`, [token])).toBe('See [redacted]');
    // What only looks like it is left as it was.
    const plain = 'Use &amp; and \\* or &#38; and &lowbar; freely, 100% of the time: abc_def-ghijklmnop.';
    expect(redact(plain, [token])).toBe(plain);
  });

  it('takes Lonca’s secrets out, including from a link', () => {
    const token = 'abcdefghijklmnopqrstuvwx';
    expect(redact(`Open http://localhost:4700/?token=${token} with ${token}`, [token, undefined, 'short'])).toBe('Open http://localhost:4700/?token=[redacted] with [redacted]');
  });
});

describe('the text a notification shows', () => {
  it('writes &, < and > as entities, keeping the ones that were already', () => {
    expect(fallbackText(quiet('a < b & <!here> &amp; <https://x.y|z>'))).toBe('a &lt; b &amp; &lt;!here&gt; &amp; &lt;https://x.y|z&gt;');
    expect(fallbackText(quiet('`<!here>`'))).toBe(`\`&lt;${ZW}!here&gt;\``);
    expect(fallbackText('**prague** in lonca')).toBe('*prague* in lonca');
  });

  it('is cut short without breaking an entity', () => {
    const text = fallbackText(`${'a'.repeat(2996)}<b`, 3000);
    expect(text).toBe(`${'a'.repeat(2996)}…`);
  });
});

describe('what the user wrote in Slack', () => {
  it('reads entities, links and mentions as the user saw them', () => {
    expect(plainText('a &lt; b &amp;&amp; c &gt; d')).toBe('a < b && c > d');
    expect(plainText('see <https://example.com/a?b=1&amp;c=2|the docs>')).toBe('see the docs (https://example.com/a?b=1&c=2)');
    expect(plainText('<https://example.com>')).toBe('https://example.com');
    expect(plainText('<http://example.com|example.com>')).toBe('example.com');
    expect(plainText('<mailto:bob@example.com|bob@example.com>')).toBe('bob@example.com');
    expect(plainText('ask <@U0123ABCD> and <@U0456|alice>')).toBe('ask @U0123ABCD and @alice');
    expect(plainText('in <#C0123|general> or <#C0456>')).toBe('in #general or #C0456');
    expect(plainText('<!here> <!channel> <!subteam^S01|@devs> <!subteam^S02>')).toBe('@here @channel @devs @S02');
    expect(plainText('by <!date^1392734382^{date}|Feb 18>')).toBe('by Feb 18');
  });
});

describe('a long reply', () => {
  const paragraph = (index: number, length = 1000) => `${index} ${'word '.repeat(length / 5)}`.trim();

  it('is one part when it fits', () => {
    expect(splitMarkdown('one\n\ntwo')).toEqual(['one\n\ntwo']);
  });

  it('is split between paragraphs, each part well within what Slack takes', () => {
    const text = Array.from({ length: 20 }, (_, index) => paragraph(index)).join('\n\n');
    const parts = splitMarkdown(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(PART_LIMIT);
    expect(parts.join('\n\n')).toBe(text);
  });

  it('closes a code block where a part ends and opens it again in the next', () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `line ${index} ${'x'.repeat(10)}`);
    const parts = splitMarkdown(`Before\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\`\n\nAfter`);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(PART_LIMIT);
      expect((part.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(parts.join('\n').split('\n').filter((line) => line.startsWith('line '))).toEqual(lines);
  });

  it('breaks a line too long for a part at a space, and never inside a character', () => {
    const parts = splitMarkdown(`${'word '.repeat(4000)}${'😀'.repeat(5000)}`);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(PART_LIMIT);
      expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it('posts only its start, and says the rest is in Lonca, when it would take too many messages', () => {
    const text = Array.from({ length: 50 }, (_, index) => paragraph(index)).join('\n\n');
    expect(splitMarkdown(text).length).toBeGreaterThan(MAX_PARTS);
    const parts = replyParts(text, '_The Lead stopped with an error._');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatch(/The rest is in Lonca\._\n\n_The Lead stopped with an error\._$/);
  });

  it('puts Lonca’s own line after the reply, or alone when there’s no reply', () => {
    expect(replyParts('Done.', '_Paused._')).toEqual(['Done.\n\n_Paused._']);
    expect(replyParts('', '_Paused._')).toEqual(['_Paused._']);
    expect(replyParts('Done.')).toEqual(['Done.']);
  });
});

describe('the Slack app', () => {
  it('asks for a DM with its user and nothing else', () => {
    expect(SLACK_SCOPES).toEqual(['chat:write', 'im:history', 'im:write', 'reactions:write']);
    const manifest = JSON.stringify(SLACK_MANIFEST);
    for (const scope of ['channels:', 'groups:', 'mpim:', 'chat:write.public', 'app_mentions:read', 'users:', 'files:', 'assistant:write']) {
      expect(manifest).not.toContain(scope);
    }
    expect(SLACK_MANIFEST.settings.event_subscriptions.bot_events).toEqual(['message.im']);
    expect(SLACK_MANIFEST.settings).toMatchObject({ socket_mode_enabled: true, interactivity: { is_enabled: false } });
    expect(SLACK_MANIFEST.features.app_home).toMatchObject({ messages_tab_enabled: true, messages_tab_read_only_enabled: false });
    expect(manifest).not.toContain('request_url');
  });
});
