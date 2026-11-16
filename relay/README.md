# Sidebots relay

The relay passes Sidebots servers' notifications to Apple. Only the Apple Developer account that builds the app can notify it, so the relay holds that account's push key, and each server sends its notices here. The relay is a Cloudflare Worker with a D1 database. It keeps each server's public key and id, and nothing about people, agents or messages.

`src/worker.ts` describes how a server signs its requests. `src/apple.ts` sends to Apple's push service.

## Run your own

You need your own relay when you build your own copy of the app, since Apple delivers only to the app identifier the push key's account owns.

1. Create a push key (an APNs auth key) in your Apple Developer account.
2. In `wrangler.jsonc`, set the `routes` pattern to a domain on your Cloudflare account, and `APNS_TOPIC` to your app's bundle identifier.
3. Sign in and make the database, then put its id in `wrangler.jsonc`:

   ```sh
   pnpm install
   npx wrangler login
   npx wrangler d1 create sidebots-relay
   npx wrangler d1 execute sidebots-relay --remote --file=schema.sql
   ```

4. Put the push key's text, its ID and your team ID in a file such as `secrets.json`, then deploy with it and delete the file:

   ```json
   { "APNS_KEY": "-----BEGIN PRIVATE KEY-----\n…", "APNS_KEY_ID": "XXXXXXXXXX", "APNS_TEAM_ID": "XXXXXXXXXX" }
   ```

   ```sh
   npx wrangler deploy --secrets-file secrets.json
   ```

5. Start the server with `SIDEBOTS_RELAY=https://<your domain>`.

The relay sends one machine at most `NOTICES_PER_DAY` notifications a day, and once a day removes the machines it hasn't heard from in 60 days.
