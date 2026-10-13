@AGENTS.md

# ShabCRM

- Package manager: pnpm. Check with `pnpm lint && pnpm typecheck && pnpm test`; browser flow with `pnpm build && pnpm test:e2e`.
- Tenant data (contacts, activities, pipelines, pipeline_stages, deals) must be read and written inside `withWorkspace()` from `src/db/tenant.ts`. Outside it, row-level security only protects you if the database user isn't a superuser, and hosted Postgres usually is.
- Pages and server actions call `requireWorkspace(id)` from `src/lib/session.ts` before touching a workspace.
- Business logic lives in `src/server/*` and takes `db` as a parameter so it can be tested in `tests/` against a real Postgres.
- Forms use `useActionForm` (`src/components/use-action-form.ts`) so typed input survives validation errors.
- SMS consent rules: never upgrade a contact whose consent is `revoked`; granting consent always records a source.
