import { expect, test } from "vitest";

import { workflow } from "./contract";

test("[approval-shall-be-permission-checked-ineligible-editor-checks-approval] rejects an unauthorized editor outside the allowed repository roles", () => {
  const source = workflow();

  expect(source).toContain('const allowed = ["write", "maintain", "admin"]');
  expect(source).toContain('if (!allowed.includes(data.permission))');
  expect(source).toContain('Ignoring approval request from ${actor}: ${data.permission}');
});
