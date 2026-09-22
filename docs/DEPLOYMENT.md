# Deploy the L&D demonstration

Target: Vercel, using the Next.js preset and Node.js 24.x. The repository includes `vercel.json` for reproducible install/build commands. No Supabase project is needed for the current synthetic-data demo.

## Before publishing

Connect the intended Vercel account and select its deployment scope. Deploy the current local source, which includes the new portal; the GitHub repository may still contain only the earlier foundation until these changes are committed and pushed.

Set runtime environment variables for each environment being deployed:

| Variable | Value |
|---|---|
| `DEMO_SESSION_SECRET` | A cryptographically random secret of at least 32 bytes, generated once and kept stable across instances. Required for reliable hosted sessions. |
| `DEMO_ADMIN_EMAIL` | Optional private demo manager email; set together with the password. |
| `DEMO_ADMIN_PASSWORD` | Optional private demo password; set together with the email. |

Store these in Vercel's environment settings, not repository files or `vercel.json`. Without custom credentials, the login screen displays the public synthetic-demo credentials. Never use them with real employee records. Rotating the session secret invalidates all demo sessions.

## Publish and verify

1. Run `npm run check` and `npm run test:e2e` before publishing changed application code.
2. Deploy the current source through the connected Vercel account. A CLI alternative is `npx vercel` after `npx vercel login`; use `--prod` for a production deployment.
3. Wait for successful deployment and capture the returned HTTPS URL.
4. Confirm unauthenticated visits show sign-in, an incorrect password is rejected, and valid credentials open the employee directory.
5. Refresh after sign-in to check session persistence, open an employee profile, verify filtering and sign out.

This is a demonstration with fictional records and demo authentication. Database storage, real account management and external integrations remain separate implementation work.

References: [Vercel CLI](https://vercel.com/docs/cli) and [environment variables](https://vercel.com/docs/environment-variables).
