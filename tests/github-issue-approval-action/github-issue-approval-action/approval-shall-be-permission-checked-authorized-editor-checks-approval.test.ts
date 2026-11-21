import { expect, test } from "vitest";

import { workflow } from "./contract";

test("[approval-shall-be-permission-checked-authorized-editor-checks-approval] records only an authorized editor's checkbox transition", () => {
  const source = workflow();

  expect(source).toMatch(/issue_comment:\s*\n\s*types:\s*\[edited\]/);
  expect(source).toContain('previousBody.includes(unchecked)');
  expect(source).toContain('comment.user.login !== botLogin');
  expect(source).toContain('comment.body.includes(checked)');
  expect(source).toContain('context.payload.sender.login');
  expect(source).toContain('getCollaboratorPermissionLevel');
  expect(source).toContain('["write", "maintain", "admin"]');
  expect(source).toContain('addLabels');
  expect(source).toContain('Approval recorded for @${actor}');
});
