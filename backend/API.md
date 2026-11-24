# API (base: /api). Auth = `Authorization: Bearer <Supabase access token>`

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | /health | public | health check |
| GET | /matches | public | matches + sections + remaining capacity |
| GET | /site | public | editable site texts + footer links |
| POST | /contact | public (10/min) | contact / error report |
| POST | /bookings | customer | reserve seats {matchSectionId, qty, name, phone} |
| GET | /bookings/mine | customer | my bookings, payments, tickets |
| POST | /bookings/:id/mock-pay | customer | MOCK payment (only if MOCK_PAYMENTS=true) |
| POST | /payments/:id/confirm | admin | manual verification {method, ref} |
| POST | /scan | gate/admin | QR check-in {token, gateId?} |
| POST | /open-entry | gate/admin | open-entry counter {matchSectionId, delta, reason?}; negative needs admin |
| GET | /me | any login | my role |
| GET | /admin/payments/pending | admin | payments waiting for verification |
| GET | /admin/stats | admin | totals (revenue kept per currency) |
| GET/POST | /admin/:table | admin | list / create (upsert for site_texts, settings) |
| PATCH/DELETE | /admin/:table/:id | admin | update / delete |

Tables: teams, stadiums, matches, sections, match_sections, gates, footer_links, site_texts, settings.
Errors: {error: CODE}. 409 = SOLD_OUT, NO_ADJACENT_SEATS, CAPACITY_REACHED, RESERVATION_EXPIRED, PAYMENT_NOT_PENDING.
Run: cd backend && cp .env.example .env && npm install && npm run dev
