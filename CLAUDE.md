@AGENTS.md

# ShabCRM

- Package manager: pnpm. Check with `pnpm lint && pnpm typecheck && pnpm test`; browser flow with `pnpm build && pnpm test:e2e`.
- Tenant data (contacts, activities, pipelines, pipeline_stages, deals, messages, calendars, appointments) must be read and written inside `withWorkspace()` from `src/db/tenant.ts`. Outside it, row-level security only protects you if the database user isn't a superuser, and hosted Postgres usually is.
- Pages and server actions call `requireWorkspace(id)` from `src/lib/session.ts` before touching a workspace.
- Business logic lives in `src/server/*` and takes `db` as a parameter so it can be tested in `tests/` against a real Postgres.
- Forms use `useActionForm` (`src/components/use-action-form.ts`) so typed input survives validation errors.
- SMS consent rules: never upgrade a contact whose consent is `revoked` (the one exception is the contact texting START themselves); granting consent always records a source. Texting without consent is only allowed within 24 hours of the contact texting or calling in (`textPermission` in `src/server/messaging`).
- Messaging goes through the provider interfaces in `src/server/messaging/providers.ts`. With no Twilio or Postmark keys set, test providers record messages without sending. Webhooks must verify the Twilio signature or the Postmark secret before doing anything.
- `booking_pages`, like `workspaces`, has no row-level security because the public booking page looks it up by slug; keep anything private out of it. Calendar credentials are encrypted with `encryptJson` (`src/server/calendars/secrets.ts`).
- Outside calendars go through the `CalendarProvider` interface (`src/server/calendars/providers.ts`); data functions take a `ProviderFactory` so tests can pass fakes.
