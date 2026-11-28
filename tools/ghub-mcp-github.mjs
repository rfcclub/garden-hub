import { execFileSync } from 'node:child_process';

function outputOf(result) {
  return typeof result === 'string' ? result : result?.stdout;
}

function jsonOutput(run, args) {
  const output = outputOf(run(args));
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`GitHub command did not return JSON: gh ${args.join(' ')}`);
  }
}

function latestReviews(reviews) {
  const ordered = [...reviews].sort((left, right) => {
    const byTime = String(left.submitted_at ?? '').localeCompare(String(right.submitted_at ?? ''));
    return byTime || String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
  const byLogin = new Map();
  for (const review of ordered) {
    const login = review.user?.login;
    if (typeof login === 'string') byLogin.set(login, review);
  }
  return [...byLogin.values()];
}

function currentApproval(snapshot) {
  return latestReviews(snapshot.reviews).find(
    (review) =>
      review.user?.login !== snapshot.author &&
      review.state === 'APPROVED' &&
      review.commit_id === snapshot.head,
  );
}

function hasCurrentChangeRequest(snapshot) {
  return latestReviews(snapshot.reviews).some(
    (review) => review.state === 'CHANGES_REQUESTED' && review.commit_id === snapshot.head,
  );
}

function splitRepo(repo) {
  const match = /^([^/]+)\/([^/]+)$/.exec(repo);
  if (!match) throw new Error(`invalid GitHub repository "${repo}"`);
  return { owner: match[1], name: match[2] };
}

export function parsePullRequestUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('a canonical GitHub PR URL is required');
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match) {
    throw new Error('a canonical GitHub PR URL is required');
  }
  const [, owner, name, number] = match;
  return {
    repo: `${owner}/${name}`,
    number: Number(number),
    url: `https://github.com/${owner}/${name}/pull/${number}`,
  };
}

export function defaultGhRunner(args, { env } = {}) {
  return {
    stdout: execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    }),
  };
}

export function getGithubLogin({ run = defaultGhRunner, env } = {}) {
  return String(outputOf(run(['api', 'user', '--jq', '.login'], { env }))).trim();
}

export function getPullRequestSnapshot({ pullRequest, run = defaultGhRunner } = {}) {
  const { repo, number, url } = pullRequest;
  const pull = jsonOutput(run, ['api', `repos/${repo}/pulls/${number}`]);
  const reviews = jsonOutput(run, ['api', `repos/${repo}/pulls/${number}/reviews`]);
  const { owner, name } = splitRepo(repo);
  const threads = jsonOutput(run, [
    'api',
    'graphql',
    '-f',
    'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}',
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${number}`,
  ]);
  const reviewThreads = threads?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(reviews) || !Array.isArray(reviewThreads)) {
    throw new Error('GitHub returned an incomplete PR review snapshot');
  }
  return {
    repo,
    number,
    url,
    author: pull.user?.login,
    head: pull.head?.sha,
    base: pull.base?.sha,
    reviews,
    unresolvedThreads: reviewThreads.filter((thread) => !thread.isResolved).length,
  };
}

export function createPullRequest({ repo, head, base, title, body = '', env, run = defaultGhRunner } = {}) {
  for (const [name, value] of Object.entries({ repo, head, base, title })) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  }
  const output = String(
    outputOf(
      run([
        'pr',
        'create',
        '--repo',
        repo,
        '--head',
        head,
        '--base',
        base,
        '--title',
        title,
        '--body',
        body,
      ], { env }),
    ),
  ).trim();
  return parsePullRequestUrl(output);
}

export function submitReview({ pullRequest, event, body = '', env, run = defaultGhRunner } = {}) {
  const normalizedEvent = {
    approve: 'APPROVE',
    request_changes: 'REQUEST_CHANGES',
    comment: 'COMMENT',
  }[event];
  if (!normalizedEvent) throw new Error('review event must be approve, request_changes, or comment');
  const login = getGithubLogin({ run, env });
  if (login === pullRequest.author) {
    throw new Error('the PR author cannot submit a review');
  }
  run([
    'api',
    '--method',
    'POST',
    `repos/${pullRequest.repo}/pulls/${pullRequest.number}/reviews`,
    '-f',
    `event=${normalizedEvent}`,
    '-f',
    `body=${body}`,
  ], { env });
  return { ok: true, event: normalizedEvent, reviewer: login };
}

export function pollWatch({ store, watch, snapshot }) {
  if (!store || !watch || !snapshot) throw new Error('store, watch, and snapshot are required');
  const next = {
    ...watch,
    lastPolledAt: new Date().toISOString(),
    lastHeadSha: snapshot.head,
  };
  if (watch.lastHeadSha && watch.lastHeadSha !== snapshot.head) {
    delete next.approvedHeadSha;
    delete next.approvedBaseSha;
    next.state = 'needs_review';
  } else {
    const approval = currentApproval(snapshot);
    if (approval && !hasCurrentChangeRequest(snapshot) && snapshot.unresolvedThreads === 0) {
      next.approvedHeadSha = snapshot.head;
      next.approvedBaseSha = snapshot.base;
      next.approvedBy = approval.user.login;
      next.state = 'awaiting_merge';
    } else {
      delete next.approvedHeadSha;
      delete next.approvedBaseSha;
      delete next.approvedBy;
      next.state = 'awaiting_review';
    }
  }
  store.saveWatch(next);
  return { state: next.state, watch: next };
}

export function evaluateMergeEligibility({ watch, snapshot } = {}) {
  if (!watch?.approvedHeadSha || watch.approvedHeadSha !== snapshot?.head) {
    return { ok: false, code: 'approval_stale' };
  }
  if (!watch.approvedBaseSha || watch.approvedBaseSha !== snapshot.base) {
    return { ok: false, code: 'base_stale' };
  }
  if (!currentApproval(snapshot)) {
    return { ok: false, code: 'approval_missing' };
  }
  if (hasCurrentChangeRequest(snapshot)) {
    return { ok: false, code: 'changes_requested' };
  }
  if (snapshot.unresolvedThreads > 0) {
    return { ok: false, code: 'review_threads_unresolved' };
  }
  return { ok: true };
}

export function mergePullRequest({ watch, snapshot, env, run = defaultGhRunner } = {}) {
  const eligibility = evaluateMergeEligibility({ watch, snapshot });
  if (!eligibility.ok) return eligibility;
  run([
    'pr',
    'merge',
    snapshot.url,
    '--repo',
    snapshot.repo,
    '--merge',
    '--match-head-commit',
    snapshot.head,
  ], { env });
  return { ok: true, head: snapshot.head };
}
