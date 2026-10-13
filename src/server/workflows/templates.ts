import type { WorkflowStep, WorkflowTrigger } from "@/db/schema";

export type WorkflowTemplate = {
  key: string;
  name: string;
  description: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
};

/** Starting points on the "New workflow" screen. Each starts turned off. */
export const TEMPLATES: WorkflowTemplate[] = [
  {
    key: "blank",
    name: "Start from scratch",
    description: "An empty workflow you can build yourself.",
    trigger: { type: "contact_created" },
    steps: [],
  },
  {
    key: "missed_call",
    name: "Missed call text back",
    description: "Texts people whose call you missed, and reminds you to call back if they don't answer.",
    trigger: { type: "missed_call" },
    steps: [
      { id: "s1", type: "send_sms", body: "Hi {{first_name|there}}, sorry we missed your call at {{business_name}}! How can we help?" },
      { id: "s2", type: "wait", amount: 1, unit: "days" },
      {
        id: "s3",
        type: "if",
        condition: { type: "replied" },
        then: [{ id: "s4", type: "add_tag", tag: "engaged" }],
        else: [{ id: "s5", type: "create_todo", title: "Call {{full_name|missed caller}} back ({{phone}})", dueInDays: 0 }],
      },
    ],
  },
  {
    key: "new_lead",
    name: "New lead welcome",
    description: "Welcomes new contacts by text or email and sends your booking link.",
    trigger: { type: "contact_created" },
    steps: [
      {
        id: "s1",
        type: "if",
        condition: { type: "text_consent" },
        then: [{ id: "s2", type: "send_sms", body: "Hi {{first_name|there}}, thanks for reaching out to {{business_name}}! Book a time here: {{booking_link}}" }],
        else: [
          {
            id: "s3",
            type: "send_email",
            subject: "Thanks for reaching out",
            body: "Hi {{first_name|there}},\n\nThanks for getting in touch with {{business_name}}. You can pick a time that suits you here: {{booking_link}}\n\nTalk soon!",
          },
        ],
      },
      { id: "s4", type: "add_tag", tag: "new lead" },
    ],
  },
  {
    key: "reminder",
    name: "Appointment reminder",
    description: "Texts a reminder the day before each booked appointment.",
    trigger: { type: "appointment_booked" },
    steps: [
      { id: "s1", type: "wait_until_appointment", hoursBefore: 24 },
      {
        id: "s2",
        type: "if",
        condition: { type: "has_upcoming_appointment" },
        then: [{ id: "s3", type: "send_sms", body: "Hi {{first_name|there}}, a reminder of your appointment with {{business_name}} on {{appointment_time}}. Reply if you need to change it." }],
        else: [],
      },
    ],
  },
  {
    key: "review",
    name: "Review request after a won deal",
    description: "Asks happy customers for a review a few days after the job is won.",
    trigger: { type: "deal_status_changed", status: "won" },
    steps: [
      { id: "s1", type: "wait", amount: 3, unit: "days" },
      { id: "s2", type: "send_sms", body: "Hi {{first_name|there}}, thanks for choosing {{business_name}}! Would you mind leaving us a quick review? It really helps." },
      { id: "s3", type: "add_tag", tag: "review requested" },
    ],
  },
  {
    key: "form",
    name: "Website form",
    description: "Your website or another app sends a lead in, and a to-do reminds you to follow up.",
    trigger: { type: "webhook" },
    steps: [
      { id: "s1", type: "add_tag", tag: "website lead" },
      { id: "s2", type: "create_todo", title: "Follow up with {{full_name|new website lead}}", dueInDays: 0 },
    ],
  },
];
