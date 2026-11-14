// The Slack app the user makes for Lonca, which Settings shows them to copy. It asks for as little
// as a DM with its user needs: no channel of any kind, so that a Lead's words can only ever reach
// the user who paired it. Socket Mode means Slack is reached over a connection Lonca opens, so
// nothing on this computer has to be reachable from outside.

export const SLACK_SCOPES = ['chat:write', 'im:history', 'im:write', 'reactions:write'];

export const SLACK_MANIFEST = {
  display_information: {
    name: 'Lonca',
    description: 'Your Lonca Leads, in a DM.',
  },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: 'Lonca', always_online: false },
  },
  oauth_config: { scopes: { bot: SLACK_SCOPES } },
  settings: {
    event_subscriptions: { bot_events: ['message.im'] },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

/** Without the letters that look like digits, so that a code can be read off a screen and typed. 32 of them, 5 bits each. */
export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 60 bits. */
export const PAIRING_LENGTH = 12;

/** A code as the user might type it: with or without its dashes, in either case, and with an O for a 0. */
export function normalizePairingCode(text: string): string {
  return text.trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
