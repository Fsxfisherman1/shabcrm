import path from "node:path";
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
  await sql`truncate table todos, messages, activities, deals, pipeline_stages, pipelines, contacts, memberships, workspaces, session, account, verification, "user" cascade`;
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
  await page.getByRole("button", { name: "Save texting and email" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

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
  await shot(page, "07-inbox");

  // Maria opted out of texts, so her conversation offers email only.
  await page.goto(`${workspaceUrl}/contacts`);
  await page.getByRole("link", { name: "Maria Lopez" }).click();
  await page.getByRole("link", { name: "Message" }).click();
  await expect(page.getByRole("tab", { name: "Email", selected: true })).toBeVisible();
  await page.getByRole("tab", { name: "Text" }).click();
  await expect(page.getByText("This contact opted out of texts.")).toBeVisible();
  await page.getByRole("tab", { name: "Email" }).click();
  await page.getByLabel("Subject").fill("Your whitening quote");
  await page.getByLabel("Message").fill("Hi Maria, the package is $1,200.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Email · .* · Sent/)).toBeVisible();

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
