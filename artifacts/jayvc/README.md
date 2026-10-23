# JayVC

JayVC is an 18+ one-to-one video-chat experience. The app has an honest local demo when its live services or the Supabase schema are unavailable. It never presents a simulated partner as a real person.

## Stack

- React + Vite landing page and call interface
- Shared Express API server under `artifacts/api-server`
- Supabase Anonymous Auth, Postgres queue, and Realtime updates
- Daily Call Object for private video rooms and short-lived participant tokens
- Cloudflare Turnstile for queue and guest-session abuse protection

## Live setup

1. Save these values in Replit Secrets or shared environment variables. Use the names in `.env.example`.
   - Secrets: `SUPABASE_SERVICE_ROLE_KEY`, `DAILY_API_KEY`, `TURNSTILE_SECRET_KEY`
   - Public configuration: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TURNSTILE_SITE_KEY`
2. In Supabase, enable Anonymous Sign-Ins and configure Turnstile CAPTCHA for Auth using the same Turnstile secret. The app passes the CAPTCHA token when it creates an anonymous guest session.
3. Apply `supabase/schema.sql` in the Supabase SQL editor. It creates guest profiles, private preferences, a reciprocal matchmaking queue, match records, reports, RLS policies, and the atomic pairing/room-provisioning functions.
4. Enable Realtime for `public.matchmaking_queue` if the SQL editor did not add it to the `supabase_realtime` publication.
5. Restart the API Server and JayVC web service. `GET /api/jayvc/config` reports live mode only after the required settings and schema are present.

The API validates every Supabase access token before matchmaking, token issuance, profile creation, or reporting. The service-role key stays on the server. Gender and match preferences are accepted only as `Male` or `Female`, saved privately, and matched only when both guests' choices are reciprocal. A SQL transaction serializes pairing and locks the selected waiting row. It does not relax a preference when no compatible guest is waiting.

Each successful pair receives a distinct private Daily room capped at two participants. The API creates the room and a short-lived meeting token for the authenticated guest; the browser receives only the room URL and that guest's token. `DAILY_TEST_ROOM_URL` in `.env.example` is a development reference only and is not used for production matching.

## Demo mode and limitations

- Without the complete service configuration and schema, the landing page remains available and labels call interactions as demo/unavailable. No remote person is shown or implied.
- A browser camera and microphone prompt is made only after the visitor presses Start.
- Guest display labels are server-generated. The Supabase anonymous ID persists across normal reloads in the same browser; clearing site data or changing devices can remove access to that guest session.
- Text messages stay in the current browser session and are not written to the app database.
- The app stores guest labels, private matching preferences, queue and match metadata, and reports. Queue rows are removed when a guest ends or leaves. Match and report records remain in Supabase until an operator removes them.
- The app does not create or store recordings. Media is handled by Daily; recording and provider-level retention depend on the Daily account configuration. Do not describe the call as unrecorded or fully anonymous.
- API rate limits are currently in-memory per server process. For multiple API replicas, move the limiter to a shared store before public launch.

## API

- `GET /api/jayvc/config` — public readiness/configuration
- `POST /api/jayvc/profile` — verify guest token and return the server-assigned display label
- `POST /api/jayvc/queue` — verify CAPTCHA and reciprocal gender preferences, then queue or match
- `GET /api/jayvc/queue` — read queue/call state and issue a scoped Daily token for the authenticated guest
- `DELETE /api/jayvc/queue` — leave the queue or end the active call
- `POST /api/jayvc/reports` — submit a report about the authenticated guest's active match

Run the web service with `pnpm --filter @workspace/jayvc run dev`; run the API service with `pnpm --filter @workspace/api-server run dev`.
