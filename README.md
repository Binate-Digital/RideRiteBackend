# RideRiteBackend (Node.js + Express + MongoDB)

Standalone API repo for RideRite (auth, rides, driver, payments). Kept separate from the web app.

| Phase | Status |
|-------|--------|
| 1. Auth | Done |
| 2. Rides + Driver dispatch | Done |
| 3. Payments (Stripe + mock) | Done |
| 4. Rentals / chauffeur | Later |

## Quick start

```bash
# MongoDB must be running
cd backend
cp .env.example .env   # if needed
npm install
npm run dev
```

API: `http://localhost:4000`  
Health: `http://localhost:4000/health`

---

## Auth endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/signup` | — | Register rider/driver |
| POST | `/api/auth/login` | — | Login (requires verified email) |
| POST | `/api/auth/verify-email` | — | Verify with token |
| GET | `/api/auth/verify-email?token=` | — | Same via query |
| POST | `/api/auth/resend-verification` | — | Resend verify token |
| POST | `/api/auth/forgot-password` | — | Request reset token |
| POST | `/api/auth/reset-password` | — | Set new password |
| POST | `/api/auth/refresh` | — | Rotate access/refresh tokens |
| GET | `/api/auth/me` | Bearer | Current user |
| PATCH | `/api/auth/me` | Bearer | Update name/phone |
| POST | `/api/auth/change-password` | Bearer | Change password |
| POST | `/api/auth/logout` | Bearer | Revoke refresh token(s) |

Dev mode returns `dev.emailVerificationToken` / `dev.passwordResetToken` when `EXPOSE_DEV_TOKENS=true`.

---

## Rides endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/rides/estimate` | any verified | Fare estimate |
| POST | `/api/rides` | rider | Book ride (`requested`) |
| GET | `/api/rides` | rider/driver | List my trips (`?as=driver`) |
| GET | `/api/rides/open` | driver | Open requests for my vehicle type |
| GET | `/api/rides/:id` | party | Trip details |
| POST | `/api/rides/:id/cancel` | rider | Cancel + fee rules |
| POST | `/api/rides/:id/accept` | driver | Accept open trip |
| POST | `/api/rides/:id/reject` | driver | Soft-decline (stays open) |
| PATCH | `/api/rides/:id/status` | driver | `en_route` → `arrived` → `in_progress` → `completed` |
| POST | `/api/rides/:id/rate` | rider | Rate completed trip |

### Trip status machine

```
requested → accepted → en_route → arrived → in_progress → completed
    ↘ cancelled (from requested/accepted/en_route/arrived)
```

### Cancel rules (aligned with current web app)

- Free within **2 minutes** or before driver assigned
- **$5 fee** after driver assigned (when paid)
- No cancel once `in_progress` / `completed`
- Offline pay (`cash`/`venmo`/`zelle`) → no charge on cancel if unpaid

---

## Driver endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/driver/me` | Profile (+ auto-create) |
| POST | `/api/driver/ensure` | Ensure role=driver + profile |
| PATCH | `/api/driver/vehicle` | Update vehicle details |
| POST | `/api/driver/online` | Go online (needs plate) |
| POST | `/api/driver/offline` | Go offline |
| POST | `/api/driver/location` | Update GPS `{ lat, lng }` |

---

## Payments endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/payments/config` | `mode` (`mock`/`stripe`) + publishable key |
| POST | `/api/payments/rides/:tripId/intent` | Create PaymentIntent (or mock) |
| POST | `/api/payments/rides/:tripId/confirm-mock` | Simulate success (mock/dev) |
| POST | `/api/payments/rides/:tripId/sync` | Pull Stripe PI status → mark paid |
| POST | `/api/payments/webhook` | Stripe webhook (raw body) |
| POST | `/api/payments/methods/setup` | SetupIntent to save card |
| GET | `/api/payments/methods` | List saved cards |
| POST | `/api/payments/methods/mock-attach` | Fake save card (mock) |
| POST | `/api/payments/methods/:id/default` | Set default PM |
| DELETE | `/api/payments/methods/:id` | Detach PM |
| GET | `/api/payments/mine` | Payment history |

### Mock vs Stripe

- **Mock (default):** no Stripe keys needed. Intent + `confirm-mock` marks trip paid.
- **Stripe test:** set `STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_PUBLISHABLE_KEY=pk_test_...`, `STRIPE_MOCK=false`, restart. Use Payment Element with `clientSecret`. Optional webhook via Stripe CLI.

Offline methods (`cash` / `venmo` / `zelle`) skip card intent; marked paid when trip completes.

---

## Postman

Import from `postman/`:

1. `RideRite_Auth.postman_collection.json`
2. `RideRite_Rides.postman_collection.json`
3. `RideRite_Payments.postman_collection.json`
4. `RideRite_Local.postman_environment.json` ← use this env

### Test rides end-to-end

1. Signup/verify **rider** → “Use current accessToken as rider”
2. Change `email` + `role=driver` → verify → “Use current accessToken as driver”
3. Driver setup → Book (`paymentMethod=card`) → Payments intent → confirm-mock → Driver lifecycle

---

## Project layout

```
backend/
  src/
    config/
    controllers/   auth | rides | driver | payments
    lib/           stripe.js
    middleware/
    models/        User | Trip | DriverProfile | Payment
    routes/
    utils/         fares | tokens | mailer
    validators/
  postman/
```

## Frontend integration notes

- `Authorization: Bearer <accessToken>`
- Refresh on 401 via `/api/auth/refresh`
- Book → if card: `POST /api/payments/rides/:id/intent` → Stripe.js / mock confirm
- Poll `GET /api/rides/:id` for `paid` + status
- Drivers poll `GET /api/rides/open` while online (websocket later)
