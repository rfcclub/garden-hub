import fs from "node:fs";

const workflowPath = new URL(
  "../../../.github/workflows/intent-approval.yml",
  import.meta.url,
);

export const workflow = () => fs.readFileSync(workflowPath, "utf8");
