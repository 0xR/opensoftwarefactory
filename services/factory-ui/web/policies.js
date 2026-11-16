"use strict";
// Policies page: the policy registry. Every version holds policy.md.

registryTab({
  tab: "policies",
  base: "/api/policies/policies",
  noun: "policy",
  files: [
    {
      name: "policy.md",
      label: "Policy (policy.md)",
      json: false,
      mono: false,
      template: () => "",
    },
  ],
});
