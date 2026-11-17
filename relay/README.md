# Sidebots relay

The relay gives each Sidebots server an address under the zone, such as `<machine id>.sidebots.app`, through a Cloudflare Tunnel, and passes the server's notifications to Apple. Only the Apple Developer account that builds the app can notify it, so the relay holds that account's push key, and each server sends its notices here. The relay is a Cloudflare Worker with a D1 database. It keeps each server's public key, id and tunnel, and nothing about people, agents or messages.

| Route | Purpose |
| --- | --- |
| `POST /machines` | Register a machine by its public key, with its server's port. Makes its tunnel and address the first time, and answers with its id, its address and its tunnel's token |
| `DELETE /machines/:id` | Remove a machine, its tunnel and its address |
| `POST /notifications` | Pass one encrypted notice to Apple for one device token, and answer `sent`, `gone` or `failed` |

`src/worker.ts` describes how a server signs its requests. `src/cloudflare.ts` makes and removes tunnels and their DNS records. `src/apple.ts` sends to Apple's push service.

## Run your own

You need your own relay when you build your own copy of the app, since Apple delivers only to the app identifier the push key's account owns.

1. Create a push key (an APNs auth key) in your Apple Developer account.
2. Create a Cloudflare API token with Account Cloudflare Tunnel Edit, Zone DNS Edit and Zone WAF Edit on your zone. Save it in a file with nothing else in it, readable only by you.
3. In `wrangler.jsonc`, set the `routes` pattern to the relay's own address on your zone, `ZONE` to the zone, `ZONE_ID` to its id, `CLOUDFLARE_ACCOUNT_ID` to your account's id, and `APNS_TOPICS` to your app's bundle identifier, then the development build's, between spaces.
4. Sign in and make the database, then put its id in `wrangler.jsonc`:

   ```sh
   pnpm install
   npx wrangler login
   npx wrangler d1 create sidebots-relay
   npx wrangler d1 execute sidebots-relay --remote --file=schema.sql
   ```

5. Put the push key's text, its ID, your team ID and the API token in a file such as `secrets.json`, then deploy with it and delete the file:

   ```json
   { "APNS_KEY": "-----BEGIN PRIVATE KEY-----\n…", "APNS_KEY_ID": "XXXXXXXXXX", "APNS_TEAM_ID": "XXXXXXXXXX", "CLOUDFLARE_API_TOKEN": "…" }
   ```

   ```sh
   npx wrangler deploy --secrets-file secrets.json
   ```

6. Set the zone's rule, which blocks any request to a machine's address that carries no `Authorization` header. The phone always sends one and a browser following a link never does, so nobody can host a web page under your zone by claiming a tunnel. The rule leaves the relay, the zone's own name and `www` alone, and running the script again sets it afresh:

   ```sh
   pnpm zone-rule <your zone> <file-holding-the-token>
   ```

7. Start the server with `SIDEBOTS_RELAY=https://<the relay's address>`.

The relay lets one network address register three new machines a minute, sends one machine at most `NOTICES_PER_DAY` notifications a day, and once a day removes the machines it hasn't heard from in 60 days, with their tunnels and addresses. A running server registers again each day, so only a machine that has been off or away that long is removed.
