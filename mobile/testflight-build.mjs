// Waits until App Store Connect has processed one build, and says what TestFlight does with it.
// An upload that succeeds only hands the build to Apple, which can still refuse it.
//
//   node testflight-build.mjs <bundle id> <build number> <key id> <issuer id>
//
// The key is an App Store Connect API key, in ~/.appstoreconnect/private_keys/AuthKey_<key id>.p8.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const [bundleId, build, keyId, issuer] = process.argv.slice(2);
const key = createPrivateKey(readFileSync(`${homedir()}/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`));
const WAIT_MINUTES = 30;

// App Store Connect takes a token signed with the key, good for a few minutes.
function token() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({ iss: issuer, iat: now, exp: now + 300, aud: "appstoreconnect-v1" })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

async function get(path) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!response.ok) throw new Error(`App Store Connect answered ${response.status} to ${path}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

const apps = await get(`/v1/apps?filter[bundleId]=${bundleId}&fields[apps]=bundleId`);
const app = apps.data.find((found) => found.attributes.bundleId === bundleId);
if (!app) throw new Error(`App Store Connect has no app with the identifier ${bundleId}`);

const deadline = Date.now() + WAIT_MINUTES * 60_000;
let state = "not listed yet";
console.log(`Waiting for Apple to process build ${build}`);
while (Date.now() < deadline) {
  const builds = await get(`/v1/builds?filter[app]=${app.id}&filter[version]=${build}&include=buildBetaDetail&fields[builds]=processingState,buildBetaDetail&fields[buildBetaDetails]=internalBuildState,externalBuildState`);
  state = builds.data[0]?.attributes.processingState ?? state;
  if (state === "VALID") {
    const testing = builds.included[0].attributes;
    console.log(`TestFlight has build ${build}: ${testing.internalBuildState} for internal testers, ${testing.externalBuildState} for external testers`);
    process.exit(0);
  }
  if (state === "INVALID" || state === "FAILED") {
    console.error(`Apple refused build ${build} (${state}). Its email to the account holder says why.`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
console.error(`Build ${build} is still ${state} after ${WAIT_MINUTES} minutes`);
process.exit(1);
