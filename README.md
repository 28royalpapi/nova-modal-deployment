# NOVA — Netlify deployment bundle

This project serves the NOVA web interface from `public/` and its on-demand browser endpoint as a Netlify Function. It connects to the existing Supabase project configured in `public/config.js`; only the public Supabase URL and anon key are included in frontend files.

## Deploy on Netlify

Use a **build deployment** (connect the repository to Netlify, or deploy the extracted project with the Netlify CLI). The build command in `netlify.toml` installs dependencies and checks source syntax. Netlify then builds `netlify/functions/browser.mjs`.

A drag-and-drop upload of only static files does not build/deploy the Chromium function. Netlify's CLI deploy can upload static files and functions together: https://cli.netlify.com/commands/deploy/

## Chromium on Linux

The function uses `@sparticuz/chromium-min` so the Chromium binaries do not need to be included in the serverless function bundle. On a cold start, the function downloads the pinned x64 Chromium pack from the official upstream GitHub release and extracts it into temporary function storage. `NOVA_CHROMIUM_PACK_URL` can override the default only with a compatible, trusted pack URL.

This is a stateless, headless Linux/Chromium process per request, not a persistent Debian VM, terminal, or GUI desktop. Netlify documents a default 60-second synchronous function execution limit and 1 GB memory, and a first cold start downloads the browser pack. Complex pages, slow sites, multi-step login flows, and MFA/CAPTCHA can time out or be refused safely. See https://docs.netlify.com/build/functions/configuration/

## Browser safeguards

- Reads public HTTPS pages and returns text, a screenshot, and a short PDF.
- Attempts a simple same-origin POST login only when the account owner explicitly authorizes it.
- Refuses CAPTCHA/MFA bypass, cross-origin login flows, insecure HTTP, and GET-based login forms.
- Closes the browser context after each request. NOVA does not save cookies/browser storage or send credentials to the language model.

This is not general-purpose shell access and does not install a persistent Debian system. Arbitrary shell execution is intentionally not exposed.

## Required credentials

- Add `OPENAI_API_KEY` to Supabase Edge Function secrets. Never put it in `public/config.js`, the ZIP, or GitHub.
- `NOVA_CHROMIUM_PACK_URL` is optional; the package has a default upstream URL.
- Supabase remains the existing authentication and data backend.

## Validation

`npm run verify:source` checks JavaScript syntax. `npm run test:chromium` launches the actual Linux Chromium binary, opens example.com, and generates a screenshot and PDF. GitHub Actions runs both checks and packages the deployment ZIP. Passing CI verifies execution in a GitHub Linux runner; a live Netlify function smoke test is still needed after deployment.

