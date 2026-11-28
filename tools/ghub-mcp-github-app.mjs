import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Permissions the Garden Hub write tools need from the agent's GitHub App.
export const REQUIRED_APP_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
};

const NOT_CONFIGURED =
  'GitHub App identity is not configured for this agent: set GHUB_MCP_GITHUB_APP_ID and '
  + 'GHUB_MCP_GITHUB_APP_PRIVATE_KEY_FILE for this server. Write tools refuse to fall back '
  + 'to the host gh login.';

const PERMISSION_LABELS = {
  contents: 'Contents: write',
  pull_requests: 'Pull requests: write',
};

function requiredPermissions(config) {
  return { ...REQUIRED_APP_PERMISSIONS, ...(config.permissions ?? {}) };
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function createAppJwt({ appId, privateKey, now = () => Date.now() } = {}) {
  if (!appId) throw new Error('a GitHub App id is required to mint a token');
  if (!privateKey) throw new Error('a GitHub App private key is required to mint a token');
  const issuedAt = Math.floor(now() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
}

export function readGithubAppConfig({ env = process.env } = {}) {
  const appId = String(env.GHUB_MCP_GITHUB_APP_ID ?? '').trim();
  const privateKeyFile = String(env.GHUB_MCP_GITHUB_APP_PRIVATE_KEY_FILE ?? '').trim();
  const installationId = String(env.GHUB_MCP_GITHUB_APP_INSTALLATION_ID ?? '').trim();
  const slug = String(env.GHUB_MCP_GITHUB_APP_SLUG ?? '').trim();
  if (!appId || !privateKeyFile) {
    throw new Error(NOT_CONFIGURED);
  }
  return {
    appId,
    privateKeyFile,
    ...(installationId ? { installationId } : {}),
    ...(slug ? { slug } : {}),
  };
}

export function noreplyIdentityOf(config) {
  if (!config.slug) return undefined;
  return `${config.appId}+${config.slug}@users.noreply.github.com`;
}

/**
 * Mint GitHub App installation tokens inside a tool call. The token is returned to
 * the caller for the lifetime of one GitHub write and is never part of tool output,
 * audit records or error messages.
 */
export function createGithubAppAuth({
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  readFile = (path) => readFileSync(path, 'utf8'),
  now = () => Date.now(),
  apiBase = 'https://api.github.com',
} = {}) {
  let cached;

  function config() {
    if (cached === undefined) cached = readGithubAppConfig({ env });
    return cached;
  }

  function describe() {
    let appConfig;
    try {
      appConfig = config();
    } catch {
      return {
        githubApp: { configured: false, requiredPermissions: REQUIRED_APP_PERMISSIONS },
      };
    }
    return {
      githubApp: {
        configured: true,
        appId: appConfig.appId,
        ...(appConfig.slug ? { slug: appConfig.slug } : {}),
        ...(noreplyIdentityOf(appConfig) ? { noreply: noreplyIdentityOf(appConfig) } : {}),
        requiredPermissions: requiredPermissions(appConfig),
      },
    };
  }

  async function request(path, { method = 'GET', jwt, body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error('GitHub App token minting failed: the GitHub API is unreachable');
    }
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    if (!response.ok) {
      throw new Error(`GitHub App token minting failed with status ${response.status}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('GitHub App token minting failed: GitHub did not return JSON');
    }
  }

  function readPrivateKey(appConfig) {
    try {
      const key = readFile(appConfig.privateKeyFile);
      if (!key.trim()) throw new Error('empty');
      return key;
    } catch {
      throw new Error(
        `GitHub App token minting failed: the configured private key file for app ${appConfig.appId} is not readable`,
      );
    }
  }

  async function installationForRepo(repo, jwt) {
    const installation = await request(`/repos/${repo}/installation`, { jwt });
    if (!installation?.id) {
      throw new Error(`GitHub App token minting failed: the app is not installed on ${repo}`);
    }
    return installation.id;
  }

  function assertPermissions(permissions, appConfig) {
    const missing = Object.entries(requiredPermissions(appConfig))
      .filter(([name, level]) => (permissions?.[name] ?? 'none') !== level)
      .map(([name, level]) => `${PERMISSION_LABELS[name] ?? `${name}: ${level}`}`);
    if (missing.length > 0) {
      throw new Error(
        `GitHub App installation is missing a required permission: ${missing.join(', ')}`,
      );
    }
  }

  async function mintToken({ repo } = {}) {
    const appConfig = config();
    const jwt = createAppJwt({ appId: appConfig.appId, privateKey: readPrivateKey(appConfig), now });
    const installationId = appConfig.installationId
      ?? (await installationForRepo(repo, jwt));
    const installation = await request(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      jwt,
      body: {},
    });
    if (typeof installation?.token !== 'string' || installation.token === '') {
      throw new Error('GitHub App token minting failed: GitHub returned no token');
    }
    assertPermissions(installation.permissions, appConfig);
    return installation.token;
  }

  return { describe, config, mintToken };
}
