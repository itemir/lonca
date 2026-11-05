// Fake sign-in services for the real `claude` and `codex` CLIs: Anthropic's and OpenAI's OAuth
// endpoints over TLS and OpenAI's device flow over HTTP. Runs inside the helper container, so the
// CLIs go through Lonca's real sign-in path and only the far end is pretend.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const DIR = '/tmp/fake-signin';
const mode = () => {
  try {
    return fs.readFileSync(`${DIR}/mode`, 'utf8').trim();
  } catch {
    return 'ok';
  }
};
const jwt = (claims) => ['{"alg":"none"}', JSON.stringify(claims), 'sig'].map((part) => Buffer.from(part).toString('base64url')).join('.');
const claims = {
  email: 'probe@example.com',
  exp: Math.floor(Date.now() / 1000) + 86400,
  'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct_probe', chatgpt_user_id: 'u' },
};

const handler = (req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    // The CLI takes a response without this for a proxy that answered instead of the real service.
    res.setHeader('request-id', 'req_fake');
    const reply = (status, body) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    // Having minted a token, the CLI asks whether the organization restricts it. This one doesn't.
    if (/^\/api\/claude_code\/(settings|policy_limits)/.test(req.url)) {
      return reply(404, { type: 'error', error: { type: 'not_found_error', message: 'No settings configured' } });
    }
    if (req.url.includes('/v1/oauth/token')) {
      if (mode() === 'rejected') return reply(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
      return reply(200, {
        access_token: `sk-ant-oat01-${'FakeTokenForTesting_-'.repeat(4)}zzzzzzzAA`,
        refresh_token: 'sk-ant-ort01-fake',
        expires_in: 31536000,
        scope: 'user:inference',
        token_type: 'Bearer',
        account: { uuid: '00000000-0000-0000-0000-000000000001', email_address: 'probe@example.com' },
        organization: { uuid: '00000000-0000-0000-0000-000000000002', name: 'probe' },
      });
    }
    if (req.url.includes('deviceauth/usercode')) {
      if (mode() === 'disabled') return reply(404, {});
      return reply(200, { device_auth_id: 'dev_1', user_code: 'FAKE-7CODE', interval: '1', expires_at: new Date(Date.now() + 9e5).toISOString() });
    }
    if (req.url.includes('deviceauth/token')) {
      if (mode() === 'denied') return reply(400, { error: 'access_denied' });
      if (!fs.existsSync(`${DIR}/approved`)) return reply(403, { error: 'authorization_pending' });
      return reply(200, { authorization_code: 'authcode_fake', code_challenge: 'challenge_fake', code_verifier: 'verifier_fake' });
    }
    if (req.url.includes('/oauth/token')) {
      if (mode() === 'rejected') return reply(400, { error: 'invalid_grant' });
      // Having signed in through a browser, Codex also asks for an API key, which it may be given.
      if (body.includes('requested_token=openai-api-key')) return reply(200, { access_token: 'sk-proj-fake-key-from-the-sign-in' });
      return reply(200, { id_token: jwt(claims), access_token: jwt(claims), refresh_token: 'rt_fake' });
    }
    return reply(200, {});
  });
};

https.createServer({ key: fs.readFileSync(`${DIR}/key.pem`), cert: fs.readFileSync(`${DIR}/cert.pem`) }, handler).listen(443, '127.0.0.1');
http.createServer(handler).listen(8080, '127.0.0.1');
