import path from "node:path";
import http from "node:http";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

const OWNER = { name: "Alex Shab", email: "alex@example.com", password: "correct-horse-battery" };
const shots = process.env.E2E_SCREENSHOTS;

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

test.beforeAll(async () => {
  const sql = postgres(process.env.E2E_DATABASE_URL ?? "postgres://shab:shab@localhost:5432/shabcrm_e2e", {
    onnotice: () => {},
  });
  await sql`truncate table form_submissions, forms, workflow_queue, workflow_run_logs, workflow_runs, workflows, todos, appointments, calendars, booking_pages, messages, activities, deals, pipeline_stages, pipelines, contacts, memberships, workspaces, session, account, verification, "user" cascade`;
  await sql.end();
});

test("owner signs up, adds a client, imports contacts, works the pipeline", async ({ page }) => {
  // Sign up as the owner. Only the first person can.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("link", { name: "Create the owner account" }).click();
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel(/Password/).fill(OWNER.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "All accounts" })).toBeVisible();
  await expect(page.getByRole("link", { name: "My Agency" })).toBeVisible();

  // Add a client account.
  await page.getByLabel("Business name").fill("Bright Smile Dental");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("heading", { name: "Bright Smile Dental" })).toBeVisible();
  await expect(page.getByLabel("Switch account").first()).toHaveValue(/[0-9a-f-]{36}/);
  const workspaceUrl = page.url();

  // Import a CSV with consent.
  await page.getByRole("link", { name: "Import CSV" }).first().click();
  await page.getByLabel("CSV file").setInputFiles(path.join(__dirname, "fixtures/customers.csv"));
  await expect(page.getByText("customers.csv: 5 rows")).toBeVisible();
  await expect(page.getByLabel("Import Name as")).toHaveValue("fullName");
  await expect(page.getByLabel("Import Mobile as")).toHaveValue("phone");
  await page.getByLabel("Yes, everyone on this list agreed to receive texts.").check();
  await page.getByLabel("How did they agree?").fill("Opted in at the front desk");
  await page.getByLabel("Tags for this import").fill("past patient");
  await shot(page, "03-import");
  await page.getByRole("button", { name: "Import 4 contacts" }).click();
  await expect(page.getByText("Import finished")).toBeVisible();
  await expect(page.getByText("3 new contacts added")).toBeVisible();
  await expect(page.getByText("1 existing contacts updated")).toBeVisible();
  await expect(page.getByText("1 rows skipped")).toBeVisible();

  // Contacts list, with tags and consent.
  await page.getByRole("link", { name: "View contacts" }).click();
  await expect(page.getByText("3 contacts")).toBeVisible();
  await page.getByRole("link", { name: /^vip/ }).click();
  await expect(page.getByText('2 contacts tagged "vip"')).toBeVisible();
  await page.getByRole("link", { name: "All", exact: true }).click();
  await shot(page, "02-contacts");

  // Adding a duplicate shows an error and keeps what was typed.
  await page.getByRole("link", { name: "Add contact" }).click();
  await page.getByLabel("First name").fill("Maria");
  await page.getByLabel("Email").fill("maria@example.com");
  await page.getByRole("button", { name: "Save contact" }).click();
  await expect(page.getByText("A contact with that email or phone already exists.")).toBeVisible();
  await expect(page.getByLabel("First name")).toHaveValue("Maria");
  await page.getByRole("link", { name: "Contacts" }).first().click();

  // Contact detail: add a note, then revoke consent.
  await page.getByRole("link", { name: "Maria Lopez" }).click();
  await expect(page.getByRole("heading", { name: "Maria Lopez" })).toBeVisible();
  await expect(page.getByText("SMS OK")).toBeVisible();
  await expect(page.getByText("Opted in at the front desk", { exact: false })).toBeVisible();
  await page.getByLabel("Note").fill("Wants whitening quote");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Wants whitening quote")).toBeVisible();
  await page.getByLabel("SMS consent").selectOption("revoked");
  await page.getByRole("button", { name: "Update consent" }).click();
  await expect(page.getByText("Opted out", { exact: true })).toBeVisible();
  await expect(page.getByLabel("SMS consent")).toHaveValue("revoked");
  await shot(page, "04-contact");

  // Add a deal for Maria from her page.
  await page.getByRole("link", { name: "Add deal" }).click();
  await expect(page.getByLabel("Deal name")).toHaveValue("Maria Lopez");
  await page.getByLabel("Deal name").fill("Whitening package");
  await page.getByLabel("Value ($)").fill("1200");
  await page.getByRole("button", { name: "Save" }).click();
  const newLead = page.getByRole("region", { name: "New lead" });
  await expect(newLead.getByText("Whitening package")).toBeVisible();

  // Drag it to "Appointment booked".
  const card = newLead.getByText("Whitening package");
  const target = page.getByRole("region", { name: "Appointment booked" });
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 15 });
  await page.mouse.up();
  await expect(target.getByText("Whitening package")).toBeVisible();
  await page.waitForLoadState("networkidle"); // let the save finish
  await page.reload();
  await expect(page.getByRole("region", { name: "Appointment booked" }).getByText("Whitening package")).toBeVisible();
  await shot(page, "05-pipeline");

  // The stage change shows on Maria's timeline.
  await page.getByRole("link", { name: "Maria Lopez" }).click();
  await expect(page.getByRole("heading", { name: "Maria Lopez" })).toBeVisible();
  await expect(page.getByText('"Whitening package" moved to Appointment booked')).toBeVisible();

  // Overview numbers.
  await page.goto(workspaceUrl);
  await expect(page.getByText("$1,200")).toBeVisible();
  await shot(page, "01-overview");

  // Messaging, in test mode: set up the account's number and from address.
  await page.goto(`${workspaceUrl}/settings`);
  await page.getByLabel("Texting number").fill("(415) 555-0100");
  await page.getByLabel("Send emails from (name)").fill("Bright Smile Dental");
  await page.getByLabel("Send emails from (address)").fill("hello@brightsmile.test");
  await page.getByLabel("WhatsApp number").fill("(415) 555-0111");
  await page.getByLabel("iMessage number").fill("(415) 555-0122");
  await page.getByRole("button", { name: "Save messaging" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByRole("switch", { name: /Clear each red count when I open that item/ })).toBeChecked();
  await page.getByRole("heading", { name: "Red counts in the sidebar" }).scrollIntoViewIfNeeded();
  await shot(page, "20-settings-counts");

  // A new customer texts in; it lands in the inbox as unread.
  await page.getByRole("link", { name: "Inbox" }).first().click();
  await expect(page.getByText("Test mode.")).toBeVisible();
  await page.getByRole("button", { name: "Pretend a customer messaged you" }).click();
  await page.getByLabel("From").fill("(415) 555-0177");
  await page.getByLabel("What they say").fill("Do you have openings Saturday?");
  await page.getByRole("button", { name: "Simulate" }).click();
  const convo = page.getByRole("link", { name: /Do you have openings Saturday/ });
  await expect(convo).toBeVisible();
  await expect(page.getByLabel("1 unread").first()).toBeVisible();

  // Reply by text (allowed because they texted first). Opening it marks it read.
  await convo.click();
  await page.getByLabel("Message").fill("Yes! Does 10am work?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Yes! Does 10am work?").first()).toBeVisible();
  await expect(page.getByText(/Text · .* · Sent/)).toBeVisible();
  await expect(page.getByLabel("1 unread")).toHaveCount(0);

  // The same customer follows up by iMessage; it joins the same conversation
  // and the reply goes back by iMessage.
  await page.getByLabel("What happens").selectOption("imessage");
  await page.getByLabel("From").fill("(415) 555-0177");
  await page.getByLabel("What they say").fill("Running 5 min late!");
  await page.getByRole("button", { name: "Simulate" }).click();
  await expect(page.getByText("Running 5 min late!").first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("tab", { name: "iMessage", selected: true })).toBeVisible();
  await page.getByLabel("Message").fill("No problem, see you soon.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/iMessage · .* · Sent/)).toBeVisible();
  await shot(page, "07-inbox");

  // A new customer writes on WhatsApp; reply there within WhatsApp's 24 hours.
  await page.getByRole("button", { name: "Pretend a customer messaged you" }).click();
  await page.getByLabel("What happens").selectOption("whatsapp");
  await page.getByLabel("From").fill("(415) 555-0133");
  await page.getByLabel("What they say").fill("Hola, do you take new patients?");
  await page.getByRole("button", { name: "Simulate" }).click();
  await page.getByRole("link", { name: /do you take new patients/ }).click();
  await expect(page.getByRole("tab", { name: "WhatsApp", selected: true })).toBeVisible();
  await page.getByLabel("Message").fill("Yes we do! Want to book a visit?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/WhatsApp · .* · Sent/)).toBeVisible();
  await page.getByRole("navigation", { name: "Channel" }).getByRole("link", { name: "WhatsApp" }).click();
  await expect(page.getByRole("link", { name: /Want to book a visit/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /see you soon/ })).toHaveCount(0);
  await shot(page, "18-inbox-whatsapp");

  // Maria opted out of texts, so her conversation offers email only.
  await page.goto(`${workspaceUrl}/contacts`);
  await page.getByRole("link", { name: "Maria Lopez" }).click();
  await page.getByRole("link", { name: "Message" }).click();
  await expect(page.getByRole("tab", { name: "Email", selected: true })).toBeVisible();
  await page.getByRole("tab", { name: "Text" }).click();
  await expect(page.getByText("This contact opted out of texts.")).toBeVisible();
  await page.getByRole("tab", { name: "WhatsApp" }).click();
  await expect(page.getByText(/WhatsApp only lets businesses reply within 24 hours/)).toBeVisible();
  await page.getByRole("tab", { name: "Email" }).click();
  await page.getByLabel("Subject").fill("Your whitening quote");
  await page.getByLabel("Message").fill("Hi Maria, the package is $1,200.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Email · .* · Sent/)).toBeVisible();

  // Booking: open every day so there are times whenever the test runs.
  await page.getByRole("link", { name: "Calendar" }).first().click();
  await page.getByLabel("Accept bookings").check();
  await page.getByLabel("Title").fill("Free consultation");
  await page.getByLabel("Page address").fill("bright-smile-e2e");
  await page.getByLabel("Notice (hours)").fill("0");
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
    await page.getByRole("checkbox", { name: day }).check();
    await page.getByLabel(`${day} opens`).fill("00:00");
    await page.getByLabel(`${day} closes`).fill("23:59");
  }
  await page.getByRole("button", { name: "Save booking page" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await shot(page, "08-calendar-settings");

  // A customer books from the public page.
  await page.goto("/book/bright-smile-e2e");
  await expect(page.getByRole("heading", { name: "Free consultation" })).toBeVisible();
  await shot(page, "09-booking-page");
  await page.locator("main button.tabular-nums").first().click();
  await page.getByLabel("First name").fill("Pat");
  await page.getByLabel("Last name").fill("Kim");
  await page.getByLabel("Email").fill("pat@example.com");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText(/You're booked for/)).toBeVisible();

  // It shows up in the CRM, as a new contact, and in the subscribe-able feed.
  await page.goto(`${workspaceUrl}/calendar`);
  await expect(page.getByText("Free consultation with")).toBeVisible();
  await expect(page.getByRole("link", { name: "Pat Kim" })).toBeVisible();
  await expect(page.getByText("Booked online")).toBeVisible();
  await shot(page, "10-calendar");
  const feedUrl = await page.getByLabel("Calendar feed").inputValue();
  const feed = await page.request.get(new URL(feedUrl).pathname);
  expect(await feed.text()).toContain("SUMMARY:Free consultation: Pat Kim");

  // Book Maria in by hand from her page.
  await page.goto(`${workspaceUrl}/contacts`);
  await page.getByRole("link", { name: "Maria Lopez" }).click();
  await page.getByRole("button", { name: "Book appointment" }).click();
  await page.getByLabel("Appointment title").fill("Whitening");
  await page.getByLabel("Date").fill("2030-01-15");
  await page.getByLabel("Time").fill("10:30");
  await page.getByRole("button", { name: "Book", exact: true }).click();
  await expect(page.getByText("Booked for Tue, Jan 15 at 10:30 AM.")).toBeVisible();
  await expect(page.getByText('"Whitening" booked for Tue, Jan 15 at 10:30 AM')).toBeVisible();

  // Forms: make a lead form, then fill it in the way a website visitor would.
  await page.goto(`${workspaceUrl}/forms`);
  await expect(page.getByText("No forms yet")).toBeVisible();
  await page.getByRole("button", { name: "New form" }).click();
  await expect(page.getByLabel("Form name")).toHaveValue("Contact form");
  const formEditorUrl = page.url();
  await page.getByLabel("Form name").fill("Quote request");
  await page.getByRole("button", { name: "+ Dropdown" }).click();
  await expect(page.getByLabel("Dropdown", { exact: true })).toHaveValue("Which service?");
  await page.getByLabel("Choices, one per line").fill("Cleaning\nWhitening");
  await page.getByLabel("Tag new leads (comma separated)").fill("website lead");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await shot(page, "14-form-builder");
  await page.getByRole("tab", { name: "Share" }).click();
  const formLink = await page.getByLabel("Form link").inputValue();
  await expect(page.getByLabel("Embed code")).toHaveValue(/<iframe/);
  await page.goto(new URL(formLink).pathname);
  await page.getByLabel(/^Name/).fill("Sam Rivera");
  await page.getByLabel(/^Email/).fill("sam@example.com");
  await page.getByLabel(/^Phone/).fill("(415) 555-0199");
  await page.getByLabel(/^Which service/).selectOption("Whitening");
  await page.getByLabel(/I agree to receive text messages/).check();
  await shot(page, "15-form-public");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks! We'll be in touch soon.")).toBeVisible();
  // The sidebar's red counts: the response counts until it's opened.
  await page.goto(workspaceUrl);
  await expect(page.getByLabel("1 new response").first()).toBeVisible();
  await shot(page, "19-sidebar-counts");
  await page.goto(formEditorUrl);
  await page.getByRole("tab", { name: /Responses \(1\)/ }).click();
  await expect(page.getByText("Whitening")).toBeVisible();
  await page.getByRole("link", { name: "Sam Rivera" }).click();
  await expect(page.getByLabel(/new response/)).toHaveCount(0);
  await expect(page.getByText("website lead").first()).toBeVisible();
  await expect(page.getByText(/Filled in "Quote request"/)).toBeVisible();
  await expect(page.getByLabel("SMS consent")).toHaveValue("granted");

  // A client's own website form, on another site, with the snippet pasted in.
  await page.goto(`${workspaceUrl}/forms`);
  const snippet = await page.getByLabel(/^Website snippet/).inputValue();
  const webhook = await page.getByLabel(/^Webhook address/).inputValue();
  const site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Bright Smile</title>${snippet}
      <form id="contact" action="/thanks" onsubmit="event.preventDefault(); document.body.append('Sent!')">
        <label for="n">Your name</label><input id="n" name="your-name">
        <label for="e">Email address</label><input id="e" name="your-email" type="email">
        <label for="m">Message</label><textarea id="m" name="your-message"></textarea>
        <button>Send message</button>
      </form>`);
  });
  await new Promise<void>((resolve) => site.listen(3199, resolve));
  try {
    await page.goto("http://localhost:3199/contact");
    await page.getByLabel("Your name").fill("Jordan Lee");
    await page.getByLabel("Email address").fill("jordan@example.com");
    await page.getByLabel("Message").fill("Do you do Saturday cleanings?");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Sent!")).toBeVisible();
  } finally {
    site.close();
  }
  const wix = await page.request.post(webhook, {
    data: { data: { "First name": "Priya", "Last name": "Shah", Email: "priya@example.com", "Preferred day": "Monday" } },
  });
  expect(wix.ok()).toBe(true);
  await page.goto(`${workspaceUrl}/forms`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("link", { name: "Form on localhost:3199/contact" })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "Contact form" })).toBeVisible();
  await shot(page, "16-forms-list");
  await page.getByRole("link", { name: "Form on localhost:3199/contact" }).click();
  await expect(page.getByText("Do you do Saturday cleanings?")).toBeVisible();
  await page.getByLabel("Name in ShabCRM").fill("Contact page");
  await page.getByLabel(/^Tag new leads/).fill("website lead");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await shot(page, "17-website-form");
  await page.getByRole("link", { name: "Jordan Lee" }).click();
  await expect(page.getByText(/Filled in "Form on localhost:3199\/contact"|Filled in "Contact page"/)).toBeVisible();

  // Automations: start from the missed-call template, add a step, turn it on.
  await page.getByRole("link", { name: "Automations" }).first().click();
  await expect(page.getByText("No workflows yet")).toBeVisible();
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByRole("button", { name: /Missed call text back/ }).click();
  await expect(page.getByLabel("Workflow name")).toHaveValue("Missed call text back");
  await page.getByRole("button", { name: "Add a step" }).last().click();
  await page.getByRole("menuitem", { name: "Add tag" }).click();
  await expect(page.getByRole("button", { name: /Add tag Choose a tag/ })).toBeVisible();
  await page.getByLabel("Tag", { exact: true }).fill("missed call");
  await page.getByRole("button", { name: /Missed call Someone calls/ }).click();
  await expect(page.getByLabel("Event")).toHaveValue("missed_call");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved. It's off until you turn it on.")).toBeVisible();
  await page.getByRole("switch", { name: "Turn workflow on" }).click();
  await expect(page.getByText("Saved. It's on.")).toBeVisible();
  await shot(page, "11-workflow-builder");
  const workflowUrl = page.url();

  // A missed call comes in, and the workflow texts them back on its own.
  await page.goto(`${workspaceUrl}/inbox`);
  await page.getByRole("button", { name: "Pretend a customer messaged you" }).click();
  await page.getByLabel("What happens").selectOption("call");
  await page.getByLabel("From").fill("(415) 555-0188");
  await page.getByRole("button", { name: "Simulate" }).click();
  await page.goto(workflowUrl);
  await page.getByRole("tab", { name: /History/ }).click();
  await expect(async () => {
    await page.reload();
    await page.getByRole("tab", { name: /History/ }).click();
    await expect(page.getByRole("link", { name: /555.?0188/ })).toBeVisible({ timeout: 1000 });
    await expect(page.getByText("Sent text")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText(/Waiting until/)).toBeVisible();
  await shot(page, "12-workflow-history");
  await page.goto(`${workspaceUrl}/automations`);
  await expect(page.getByRole("link", { name: "Missed call text back" })).toBeVisible();
  await shot(page, "13-automations");

  // To-do list.
  await page.getByRole("link", { name: "To-do" }).first().click();
  await page.getByLabel("To-do", { exact: true }).fill("Call Maria about whitening");
  await page.getByLabel("Link to account").selectOption({ label: "Bright Smile Dental" });
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Call Maria about whitening")).toBeVisible();
  await page.getByLabel("To-do", { exact: true }).fill("Send monthly report");
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByLabel('Mark "Send monthly report" done').click();
  await expect(page.getByText("Done (1)")).toBeVisible();
  await shot(page, "06-todos");

  // Agency overview totals.
  await page.getByRole("link", { name: "All accounts" }).click();
  await expect(page.getByRole("heading", { name: "All accounts" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Bright Smile Dental" })).toBeVisible();
  await shot(page, "00-agency");

  // Sign-ups are now closed.
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/signup");
  await expect(page.getByText("Sign-ups are closed.")).toBeVisible();

  // And the owner can sign back in.
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "All accounts" })).toBeVisible();
});
