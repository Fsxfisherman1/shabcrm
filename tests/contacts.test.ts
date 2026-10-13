import { beforeEach, describe, expect, it } from "vitest";
import {
  addNote,
  createContact,
  DuplicateContactError,
  getContact,
  importContacts,
  listContacts,
  listTags,
  setSmsConsent,
} from "@/server/contacts";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

describe("contacts", () => {
  beforeEach(resetDb);

  it("normalizes email and phone, and rejects duplicates", async () => {
    const alex = await makeUser();
    const ws = await makeWorkspace(alex.id);
    const c = await createContact(
      db,
      ws.id,
      { firstName: " Jane ", email: "Jane@Example.com", phone: "(415) 555-0132", tags: ["Lead", "lead"] },
      alex.id,
    );
    expect(c.email).toBe("jane@example.com");
    expect(c.phone).toBe("+14155550132");
    expect(c.tags).toEqual(["lead"]);
    expect(c.smsConsent).toBe("none");

    await expect(
      createContact(db, ws.id, { phone: "415-555-0132" }, alex.id),
    ).rejects.toBeInstanceOf(DuplicateContactError);
  });

  it("searches by name, email, phone digits and tag", async () => {
    const alex = await makeUser();
    const ws = await makeWorkspace(alex.id);
    await createContact(db, ws.id, { firstName: "Jane", lastName: "Doe", email: "jane@x.com", tags: ["vip"] }, alex.id);
    await createContact(db, ws.id, { firstName: "Bob", phone: "4155550199" }, alex.id);

    expect((await listContacts(db, ws.id, { search: "jane doe" })).total).toBe(1);
    expect((await listContacts(db, ws.id, { search: "x.com" })).total).toBe(1);
    expect((await listContacts(db, ws.id, { search: "555-0199" })).total).toBe(1);
    expect((await listContacts(db, ws.id, { tag: "vip" })).rows[0].firstName).toBe("Jane");
    expect(await listTags(db, ws.id)).toEqual([{ tag: "vip", n: 1 }]);
  });

  it("records notes and consent changes on the timeline", async () => {
    const alex = await makeUser();
    const ws = await makeWorkspace(alex.id);
    const c = await createContact(db, ws.id, { firstName: "Jane", email: "j@x.com" }, alex.id);
    await addNote(db, ws.id, c.id, "Called, wants a quote", alex.id);
    await setSmsConsent(db, ws.id, c.id, { smsConsent: "granted", smsConsentSource: "Verbal on phone call" }, alex.id);

    const detail = await getContact(db, ws.id, c.id);
    expect(detail!.contact.smsConsent).toBe("granted");
    expect(detail!.contact.smsConsentAt).toBeInstanceOf(Date);
    expect(detail!.timeline.map((a) => a.kind)).toEqual(["consent_changed", "note", "created"]);
  });
});

describe("CSV import", () => {
  beforeEach(resetDb);

  it("creates, merges and skips rows", async () => {
    const alex = await makeUser();
    const ws = await makeWorkspace(alex.id);
    await createContact(db, ws.id, { firstName: "Jane", email: "jane@x.com", tags: ["old"] }, alex.id);

    const result = await importContacts(
      db,
      ws.id,
      [
        { firstName: "Jane", email: "JANE@x.com", phone: "4155550100", company: "Jane Co" },
        { firstName: "Bob", phone: "415 555 0101" },
        { firstName: "No contact info" },
        { firstName: "Bob again", phone: "+1 415-555-0101" },
      ],
      { consent: { smsConsent: "granted", smsConsentSource: "Past customer" }, tags: ["imported"], source: "customers.csv" },
      alex.id,
    );
    expect(result).toEqual({ created: 1, updated: 2, skipped: 1 });

    const { rows } = await listContacts(db, ws.id);
    const jane = rows.find((r) => r.email === "jane@x.com")!;
    expect(jane.phone).toBe("+14155550100");
    expect(jane.company).toBe("Jane Co");
    expect(jane.tags.sort()).toEqual(["imported", "old"]);
    expect(jane.smsConsent).toBe("granted");
    const bob = rows.find((r) => r.phone === "+14155550101")!;
    expect(bob.firstName).toBe("Bob");
    expect(bob.smsConsentSource).toBe("Past customer");
  });

  it("never re-grants consent to someone who opted out", async () => {
    const alex = await makeUser();
    const ws = await makeWorkspace(alex.id);
    const c = await createContact(db, ws.id, { firstName: "Jane", phone: "4155550100" }, alex.id);
    await setSmsConsent(db, ws.id, c.id, { smsConsent: "revoked" }, alex.id);

    await importContacts(
      db,
      ws.id,
      [{ phone: "4155550100" }],
      { consent: { smsConsent: "granted", smsConsentSource: "Past customer" } },
      alex.id,
    );
    const detail = await getContact(db, ws.id, c.id);
    expect(detail!.contact.smsConsent).toBe("revoked");
  });
});
