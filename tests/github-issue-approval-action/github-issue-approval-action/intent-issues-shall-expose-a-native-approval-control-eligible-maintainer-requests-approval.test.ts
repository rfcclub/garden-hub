import { expect, test } from "vitest";

import { workflow } from "./contract";

test("[intent-issues-shall-expose-a-native-approval-control-eligible-maintainer-requests-approval] posts one bot-owned native approval checkbox", () => {
  const source = workflow();

  expect(source).toMatch(/issues:\s*\n\s*types:\s*\[opened, edited, reopened\]/);
  expect(source).toContain('orca:intent');
  expect(source).toContain('<!-- garden-hub-intent-approve -->');
  expect(source).toContain('- [ ] Approve implementation');
  expect(source).toContain('github.paginate(github.rest.issues.listComments');
  expect(source).toContain('github-actions[bot]');
  expect(source).toContain('github.rest.issues.createComment');
});
