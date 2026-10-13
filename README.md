# ShabCRM

A lean CRM for running an agency and its small-business clients: separate
accounts per client, contacts with SMS consent tracking, CSV import,
drag-and-drop pipelines, a shared text and email inbox with missed-call
text-back, online booking with calendar connections, website lead forms,
workflow automations, and a personal to-do list.

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

## Forms

Each account has a **Forms** tab for lead forms. A form has contact fields
(name, email, phone, company) that fill in the contact, plus your own
questions (short answer, paragraph or dropdown). Every response:

- adds the person to Contacts, or updates the existing contact with the same
  email or phone without overwriting what's already there,
- applies the form's tags,
- records text consent when they tick the consent checkbox (never for someone
  who opted out),
- shows up on the form's Responses tab and the contact's activity, and
- can start a workflow with the "Form filled in" trigger. Answers to your own
  questions can go in messages as `{{data.question_label}}`.

Share a form by its link (`/f/<address>`) or paste the embed code from the
Share tab into any website builder's HTML block. The embedded form resizes
itself to fit.

## Automations

Each account has an **Automations** tab for workflows: a trigger (a new
contact, a tag added, a text or email received, a missed call, an appointment
booked or canceled, a deal moved or won, data sent in from another app, or
adding someone by hand) followed by a list of steps. Steps can send a text or
email, wait a while or until shortly before an appointment, add or remove a
tag, add a note, create or move a deal, create a to-do, notify you, send the
contact's details to another app, or branch with if/else.

- Messages can use merge fields like `{{first_name}}` or `{{first_name|there}}`
  (with a fallback), plus `{{data.anything}}` for fields sent in from another app.
- Texts follow the same consent rules as the inbox. A contact who can't be
  texted is skipped and the workflow carries on.
- By default a contact leaves a workflow when they reply, and only goes
  through it once. Both are settings on each workflow.
- Turning a workflow off stops new contacts from entering; anyone already in it
  finishes. "Stop everyone in progress" ends them all.
- The History tab shows each contact's path through the workflow, step by step.
- The "Data sent in" trigger gives the workflow a private address. POST JSON or
  form data with an `email` or `phone` (and optionally `name`) from a website
  form, Zapier or Make to add the contact and start the workflow.

Steps run in the background inside the app, checked every few seconds. Set
`WORKFLOW_WORKER=off` to stop one copy of the app from running them.

## Calendars and booking

Each account has a **Calendar** tab with its upcoming appointments, a public
booking page (`/book/<address>`) and its connected calendars. The booking page
only offers times inside the open hours that are free on every connected
calendar set to "check for conflicts", and new appointments are copied to the
calendar set to "add new appointments here".

Ways to connect a calendar:

| Calendar | How | Can add appointments |
| --- | --- | --- |
| Google Calendar | Connect button (needs the one-time setup below) | Yes |
| Outlook / Microsoft 365 | Connect button (needs the one-time setup below) | Yes |
| Apple iCloud, Fastmail, Nextcloud, Zoho and other CalDAV | Username and app-specific password | Yes |
| Anything with an iCal link (including Google and Outlook) | Paste the private link | No, busy times only |

Every account also gets a private feed link you can subscribe to from any
calendar app to see its appointments there.

### Connect Google Calendar (one-time setup)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
2. Under **Google Auth Platform**, set up the consent screen as **External**, then
   **publish the app** (Audience → Publish). Left in "Testing", Google disconnects
   calendars after 7 days. Until Google verifies the app, people connecting see an
   "unverified app" screen; choose **Advanced → Go to (app)**.
3. Under **Clients**, create an OAuth client of type **Web application** with the
   redirect URI `<your app URL>/api/calendars/callback/google`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and restart.

### Connect Outlook / Microsoft 365 (one-time setup)

1. In [Microsoft Entra](https://entra.microsoft.com/), go to **App registrations → New registration**.
   Choose accounts in **any organizational directory and personal Microsoft accounts**, and add a
   **Web** redirect URI `<your app URL>/api/calendars/callback/microsoft`.
2. Under **API permissions**, add Microsoft Graph delegated permissions `Calendars.ReadWrite`,
   `User.Read` and `offline_access`.
3. Under **Certificates & secrets**, create a client secret (note when it expires).
4. Set `MICROSOFT_CLIENT_ID` (the Application ID) and `MICROSOFT_CLIENT_SECRET` and restart.

Calendar passwords and tokens are encrypted with a key derived from
`BETTER_AUTH_SECRET`; changing that secret means reconnecting calendars.

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
