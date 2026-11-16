// Sets the zone's rule that blocks any request to a machine's address that has
// no `Authorization` header. The phone always sends one and a web browser
// following a link never does, so nobody can host a web page under the zone by
// claiming a tunnel. The relay, the zone's own name and `www` are left alone.
// The zone's other custom rules stay as they are, and running it again sets the
// rule to the one here.
//
//   node zone-rule.ts <zone> <file-holding-an-api-token>
//
// The token needs Zone WAF Edit on the zone.

import { readFileSync } from "node:fs";
import { cloudflare } from "./src/cloudflare.ts";

type Rule = { id?: string; ref: string; description: string; expression: string; action: string };

const [zone, tokenFile] = process.argv.slice(2);
if (!zone || !tokenFile) {
  console.error("usage: node zone-rule.ts <zone> <file-holding-an-api-token>");
  process.exit(1);
}
const token = readFileSync(tokenFile, "utf8").trim();
const call = <T>(method: string, path: string, body?: object) => cloudflare<T>(token, fetch, method, path, body);

const [found] = await call<{ id: string }[]>("GET", `/zones?name=${zone}`);
if (!found) {
  console.error(`The token can't see a zone called ${zone}.`);
  process.exit(1);
}
const rule: Rule = {
  ref: "sidebots_machine_needs_authorization",
  description: "Sidebots: a machine's address takes only requests with an Authorization header",
  expression: `ends_with(lower(http.host), ".${zone}") and not lower(http.host) in {"relay.${zone}" "www.${zone}"} and not any(lower(http.request.headers.names[*])[*] == "authorization")`,
  action: "block",
};

// A zone has one ruleset of custom rules, which Cloudflare makes with its first rule.
const rulesets = await call<{ id: string; kind: string; phase: string }[]>("GET", `/zones/${found.id}/rulesets`);
const custom = rulesets.find((ruleset) => ruleset.kind === "zone" && ruleset.phase === "http_request_firewall_custom");
if (!custom) {
  await call("PUT", `/zones/${found.id}/rulesets/phases/http_request_firewall_custom/entrypoint`, { rules: [rule] });
} else {
  const { rules = [] } = await call<{ rules?: Rule[] }>("GET", `/zones/${found.id}/rulesets/${custom.id}`);
  const kept = rules.find((each) => each.ref === rule.ref);
  if (kept) await call("PATCH", `/zones/${found.id}/rulesets/${custom.id}/rules/${kept.id}`, rule);
  else await call("POST", `/zones/${found.id}/rulesets/${custom.id}/rules`, rule);
}
console.log(`${zone} blocks requests to a machine's address that have no Authorization header.`);
