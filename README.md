# ShabCRM

A lean CRM for running an agency and its small-business clients: separate
accounts per client, contacts with SMS consent tracking, CSV import,
drag-and-drop pipelines, a shared text and email inbox with missed-call
text-back, and a personal to-do list.

## Run it on your computer

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.

```bash
git clone https://github.com/Fsxfisherman1/shabcrm.git
cd shabcrm
docker compose up --build
```

Open http://localhost:3000 and click **Create the owner account**. Only the
first person can sign up; that account owns the agency.

Your data lives in a Docker volume, so it survives restarts. Stop with
`Ctrl+C`, start again with `docker compose up`. To wipe everything and start
fresh: `docker compose down -v`.

## Texting and email

Until Twilio and Postmark keys are set, the app runs in **test mode**: you can
send messages from the inbox and they are saved, but nothing goes out. The
inbox has a "Pretend a customer messaged you" button for trying replies,
emails and missed calls.

To go live, set the variables in `.env.example` (`TWILIO_*`, `POSTMARK_*`),
then for each account open **Settings → Texting and email**, enter its Twilio
number, and paste the webhook URLs shown there into Twilio (the number's
"A message comes in" and "A call comes in") and Postmark (inbound webhook).
Calls to the Twilio number ring the "Forward calls to" phone; if nobody picks
up, the caller gets the missed-call text.

Texting rules are built in: contacts who reply STOP are never texted again
(unless they reply START), and a contact without recorded consent can only be
texted within 24 hours of them texting or calling you.

## Develop

Requires Node 22, pnpm and Postgres 16.

```bash
pnpm install
cp .env.example .env        # then fill in BETTER_AUTH_SECRET
pnpm db:migrate
pnpm dev
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the app with hot reload on http://localhost:3000 |
| `pnpm test` | Data-layer tests against `TEST_DATABASE_URL` (default `shabcrm_test`) |
| `pnpm test:e2e` | Browser test of the main flows against a production build (run `pnpm build` first) |
| `pnpm db:generate` | Create a migration after changing `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |

## How it's put together

- **Next.js 16** (App Router, server actions) in `src/app`
- **Postgres + Drizzle** — schema in `src/db/schema.ts`, migrations in `drizzle/`
- **Better Auth** for email and password sign-in (`src/lib/auth.ts`)
- **Data layer** in `src/server/*` — plain functions that take a db and a
  workspace id, tested in `tests/`

### Client data isolation

Every client's rows carry a `workspace_id`, and Postgres row-level security
enforces it. Tenant queries run through `withWorkspace()` (`src/db/tenant.ts`),
which switches to the restricted `shab_app` role and sets the workspace for
that transaction. A query that forgets a `where workspace_id = …` still can't
read or write another client's data. Queries outside `withWorkspace()` are
not protected when the database user is a superuser (as on most hosts), so
tenant data must always go through it.
