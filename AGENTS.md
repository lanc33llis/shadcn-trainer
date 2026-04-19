# AGENTS.md

<agent_guide>
  <purpose>
    This file translates `CONTRIBUTING.md` into repository-specific guidance for OpenAI models and other coding agents working in this monorepo.
  </purpose>

  <repository_overview>
    <name>ui.shadcn.com</name>
    <type>monorepo</type>
    <package_manager>pnpm</package_manager>
    <workspace_model>pnpm workspaces</workspace_model>
    <build_system>Turborepo</build_system>
    <release_management>changesets</release_management>
  </repository_overview>

  <workspace_map>
    <workspace>
      <path>apps/v4/app</path>
      <role>Next.js application for the website.</role>
    </workspace>
    <workspace>
      <path>apps/v4/components</path>
      <role>React components used by the website.</role>
    </workspace>
    <workspace>
      <path>apps/v4/content</path>
      <role>Documentation and MDX content.</role>
    </workspace>
    <workspace>
      <path>apps/v4/registry</path>
      <role>Registry source for component styles, examples, bases, and icons.</role>
    </workspace>
    <workspace>
      <path>packages/shadcn</path>
      <role>The `shadcn` CLI package.</role>
    </workspace>
    <workspace>
      <path>packages/tests</path>
      <role>Test fixtures and test helpers for cross-project behavior.</role>
    </workspace>
  </workspace_map>

  <source_of_truth>
    <file>CONTRIBUTING.md</file>
    <instruction>Prefer the contributor guide when this file and the codebase disagree. Prefer the codebase when commands in docs are outdated.</instruction>
  </source_of_truth>

  <general_rules>
    <rule>Use `pnpm` for dependency management and script execution.</rule>
    <rule>Assume changes should stay scoped to the relevant workspace unless the task explicitly requires cross-workspace edits.</rule>
    <rule>Do not introduce a new workflow when an existing repo script already covers it.</rule>
    <rule>When modifying components or docs, check whether registry output or documentation updates are also required.</rule>
    <rule>Before finishing, run the narrowest relevant verification command that matches the area you changed.</rule>
  </general_rules>

  <development_commands>
    <command>
      <name>Install dependencies</name>
      <run>`pnpm install`</run>
    </command>
    <command>
      <name>Run all dev targets</name>
      <run>`pnpm dev`</run>
    </command>
    <command>
      <name>Run the docs/site workspace</name>
      <run>`pnpm --filter=v4 dev`</run>
      <alias>`pnpm v4:dev`</alias>
    </command>
    <command>
      <name>Run the CLI package in watch mode</name>
      <run>`pnpm --filter=shadcn dev`</run>
      <alias>`pnpm shadcn:dev`</alias>
    </command>
    <command>
      <name>Run the local CLI against current sources</name>
      <run>`pnpm shadcn`</run>
    </command>
    <command>
      <name>Build the registry after registry/component changes</name>
      <run>`pnpm registry:build`</run>
    </command>
    <command>
      <name>Lint, typecheck, and format check</name>
      <run>`pnpm check`</run>
    </command>
    <command>
      <name>Run the full test flow from repo root</name>
      <run>`pnpm test`</run>
    </command>
    <command>
      <name>Run CLI package tests only</name>
      <run>`pnpm shadcn:test`</run>
    </command>
    <command>
      <name>Run app-focused tests only</name>
      <run>`pnpm test:apps`</run>
    </command>
  </development_commands>

  <task_routing>
    <route>
      <when>Website pages, docs pages, or MDX content change.</when>
      <work_in>apps/v4</work_in>
      <verify>`pnpm --filter=v4 dev` or another relevant `v4` check.</verify>
    </route>
    <route>
      <when>CLI behavior changes.</when>
      <work_in>packages/shadcn</work_in>
      <verify>`pnpm shadcn:test` and any targeted manual CLI run.</verify>
    </route>
    <route>
      <when>Registry components, examples, or styles change.</when>
      <work_in>apps/v4/registry</work_in>
      <verify>`pnpm registry:build`.</verify>
    </route>
    <route>
      <when>Cross-workspace behavior or fixture coverage changes.</when>
      <work_in>packages/tests</work_in>
      <verify>Run the smallest relevant test target, then escalate to `pnpm test` if needed.</verify>
    </route>
  </task_routing>

  <component_and_registry_rules>
    <rule>Registry-backed component work lives under `apps/v4/registry`.</rule>
    <rule>When adding or modifying components, update every affected style instead of patching only one variant.</rule>
    <rule>Update documentation for component-facing changes.</rule>
    <rule>After registry changes, run `pnpm registry:build` so generated artifacts stay in sync.</rule>
  </component_and_registry_rules>

  <documentation_rules>
    <rule>Docs live in `apps/v4/content/docs` and use MDX.</rule>
    <rule>Documentation changes should be previewed through the `v4` workspace.</rule>
    <rule>When user-facing behavior changes, update docs in the same change unless the task explicitly excludes docs.</rule>
  </documentation_rules>

  <cli_rules>
    <rule>The CLI source of truth is `packages/shadcn`.</rule>
    <rule>When changing CLI behavior, prefer adding or updating tests.</rule>
    <rule>For local CLI validation, start the dev server with `pnpm dev`, then run `pnpm shadcn` in a separate shell.</rule>
    <rule>You can target a specific app during CLI testing with `pnpm shadcn &lt;init | add | ...&gt; -c /path/to/app`.</rule>
  </cli_rules>

  <testing_expectations>
    <rule>Tests use Vitest.</rule>
    <rule>Run the smallest relevant verification first, then broader checks if the change affects shared behavior.</rule>
    <rule>If you add a feature or change behavior, add or update tests when practical.</rule>
    <rule>Do not claim a task is complete if required verification was skipped; state what was not run.</rule>
  </testing_expectations>

  <commit_conventions>
    <format>`category(scope or module): message`</format>
    <allowed_categories>`feat`, `fix`, `refactor`, `docs`, `build`, `test`, `ci`, `chore`</allowed_categories>
    <example>`feat(components): add new prop to the avatar component`</example>
  </commit_conventions>

  <pull_request_expectations>
    <rule>Check for related open issues or pull requests before duplicating work.</rule>
    <rule>Keep changes focused and explain affected workspaces clearly.</rule>
    <rule>Include docs and generated registry updates when the underlying change requires them.</rule>
    <rule>Ensure relevant tests pass before marking work ready for review.</rule>
  </pull_request_expectations>

  <agent_behavior>
    <rule>Prefer repo scripts over ad hoc commands.</rule>
    <rule>Prefer targeted verification over expensive full-repo runs unless the task affects shared infrastructure.</rule>
    <rule>When uncertain where a change belongs, inspect `apps/v4` for site work and `packages/shadcn` for CLI work before editing.</rule>
    <rule>When a request mentions a new component, consider whether the change belongs in the registry, docs, or both.</rule>
  </agent_behavior>
</agent_guide>
