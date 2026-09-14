# Backend domain services

Logical service boundaries inside the **same Node.js process** (modular monolith).
Each domain can later become its own microservice without changing client URLs.

## Domains

| Domain | Mount | Routes file | Primary repo |
|--------|-------|-------------|--------------|
| `auth` | `/auth` | `routes/auth.js` | `users` |
| `platform` | `/app`, `/maps` | `routes/app.js`, `routes/maps.js` | `admin` (settings) |
| `user` | `/db` | `routes/users.js` | `users`, `customer_data`, `orders` |
| `merchant` | `/db` | `routes/merchants.js` | `merchants`, `orders` |
| `marketplace` | `/db` | `routes/marketplace.js` | `merchants` (read listings) |
| `delivery` | `/db` | `routes/delivery.js` | `orders` (courier) |
| `taxi` | `/db/taxi` | `routes/taxi.js` | `taxi`, `taxi_favorites` |
| `chat` | `/db/chat` | `routes/chat.js` | `chat` |
| `voice` | `/db/voice` | `routes/voice.js` | `call_logs` |
| `notifications` | — | (workers only) | `push_notifications` |
| `admin` | `/db` | `routes/admin.js` | `admin`, `admin_roles` |

Registry: `domains/registry.js` — used by `server.js`.

## Migration path

1. **Done:** registry + domain index files document ownership
2. **Next:** move `routes/taxi.js` → `domains/taxi/routes.js`
3. **Next:** colocate `supabase_repo/taxi.js` under `domains/taxi/repository.js`
4. **Last:** extract `admin` orchestration to call domain services, not raw repos

## Payment service (future)

Add `domains/payment/` when wallet/checkout ships. Not mounted yet.
