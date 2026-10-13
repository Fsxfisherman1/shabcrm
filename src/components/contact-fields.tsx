import type { Contact } from "@/db/schema";
import { formatPhone } from "@/lib/phone";
import { Field, Input } from "./ui";

export function ContactFields({ contact }: { contact?: Contact }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="First name" name="firstName">
        <Input id="firstName" name="firstName" defaultValue={contact?.firstName} autoComplete="off" />
      </Field>
      <Field label="Last name" name="lastName">
        <Input id="lastName" name="lastName" defaultValue={contact?.lastName} autoComplete="off" />
      </Field>
      <Field label="Email" name="email">
        <Input id="email" name="email" type="email" defaultValue={contact?.email ?? ""} autoComplete="off" />
      </Field>
      <Field label="Mobile phone" name="phone">
        <Input id="phone" name="phone" type="tel" defaultValue={formatPhone(contact?.phone)} autoComplete="off" />
      </Field>
      <Field label="Company" name="company">
        <Input id="company" name="company" defaultValue={contact?.company ?? ""} />
      </Field>
      <Field label="Source" name="source">
        <Input id="source" name="source" defaultValue={contact?.source ?? ""} placeholder="e.g. Referral, Google" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Tags (comma separated)" name="tags">
          <Input id="tags" name="tags" defaultValue={contact?.tags.join(", ")} placeholder="e.g. past customer, vip" />
        </Field>
      </div>
    </div>
  );
}
