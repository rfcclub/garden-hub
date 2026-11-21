import { expect, test } from "vitest";

import { workflow } from "./contract";

test("[the-approval-workflow-shall-be-least-privilege-unrelated-issue-edit] grants no content-write or pull-request-write privilege", () => {
  const source = workflow();

  expect(source).toMatch(/contents:\s*read/);
  expect(source).toMatch(/issues:\s*write/);
  expect(source).not.toMatch(/pull-requests:\s*write/);
  expect(source).not.toMatch(/contents:\s*write/);
});
