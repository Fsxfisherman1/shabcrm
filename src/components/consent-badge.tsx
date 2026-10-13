import { Badge } from "./ui";

export function ConsentBadge({ consent }: { consent: "granted" | "none" | "revoked" }) {
  if (consent === "granted") return <Badge tone="green">SMS OK</Badge>;
  if (consent === "revoked") return <Badge tone="red">Opted out</Badge>;
  return <Badge>No SMS consent</Badge>;
}
