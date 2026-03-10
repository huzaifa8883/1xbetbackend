# BetPro Exchange – Backend API v2.0

Professional Node.js REST API backend for a Betfair-powered sports exchange platform.  
**Stack:** Node.js · Express · MySQL (Sequelize ORM) · Socket.IO · JWT Auth

---

## 📁 Project Structure

```
betpro-backend/
├── src/
│   ├── app.js                  # Express app factory (middleware, routes)
│   ├── server.js               # HTTP server bootstrap + Socket.IO + graceful shutdown
│   ├── config/
│   │   ├── constants.js        # App-wide enums, role hierarchy, sport maps
│   │   └── database.js         # Sequelize + MySQL pool setup
│   ├── controllers/            # Route handlers (thin – delegates to services)
│   │   ├── auth.controller.js
│   │   ├── user.controller.js
│   │   ├── order.controller.js
│   │   └── market.controller.js
│   ├── jobs/
│   │   └── market.job.js       # Recurring market update / auto-match job
│   ├── middleware/
│   │   ├── authenticate.js     # JWT + RBAC middleware
│   │   ├── errorHandler.js     # Global error + 404 handlers
│   │   └── validate.js         # express-validator error collector
│   ├── models/                 # Sequelize models
│   │   ├── index.js            # Associations
│   │   ├── User.js
│   │   ├── Order.js
│   │   └── Transaction.js
│   ├── routes/
│   │   └── v1/                 # Versioned routes
│   │       ├── index.js
│   │       ├── auth.routes.js
│   │       ├── user.routes.js
│   │       ├── order.routes.js
│   │       └── market.routes.js
│   ├── services/
│   │   ├── betfair.service.js  # All Betfair API calls (cached session token)
│   │   ├── matching.service.js # Pure bet-matching engine logic
│   │   └── order.service.js    # Order lifecycle: place, match, settle, recalculate
│   ├── utils/
│   │   ├── logger.js           # Winston structured logger with log rotation
│   │   └── response.js         # Standardised API response helpers
│   └── validators/
│       └── index.js            # express-validator rule sets
├── scripts/
│   ├── migrate.js              # Sync DB schema
│   └── seed.js                 # Seed SuperAdmin user
├── logs/                       # Auto-created at runtime
├── .env.example
├── .gitignore
└── package.json
```

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your MySQL credentials, Betfair API keys, JWT secret, etc.
```

### 3. Create MySQL database
```sql
CREATE DATABASE betpro CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'betpro_user'@'localhost' IDENTIFIED BY 'StrongPassword@2025';
GRANT ALL PRIVILEGES ON betpro.* TO 'betpro_user'@'localhost';
FLUSH PRIVILEGES;
```

### 4. Run migrations + seed
```bash
npm run migrate   # Create/update tables
npm run seed      # Create SuperAdmin user
```

### 5. Start the server
```bash
npm run dev       # Development (nodemon)
npm start         # Production
```

---

## 🌐 API Reference

**Base URL:** `http://localhost:5000/api/v1`

### Authentication
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| POST | `/auth/login` | Public | Login → returns JWT |
| GET | `/auth/me` | Authenticated | Current user info |

### Users
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| GET | `/users` | Admin+ | List all users |
| POST | `/users` | Authenticated | Create user (role-based) |
| GET | `/users/me` | Authenticated | My profile |
| GET | `/users/downline` | Authenticated | My direct children |
| POST | `/users/transaction` | Authenticated | Deposit / Withdrawal |
| POST | `/users/credit-transaction` | Authenticated | Credit operations |
| GET | `/users/:id` | Authenticated | Get user by ID |
| PUT | `/users/:id` | Authenticated | Update user |
| DELETE | `/users/:id` | Admin+ | Delete user |
| GET | `/users/:id/transactions` | Authenticated | Transaction history |

### Orders
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| GET | `/orders` | Authenticated | All orders (paginated) |
| POST | `/orders` | User role only | Place bet(s) |
| GET | `/orders/pending` | Authenticated | PENDING orders |
| GET | `/orders/matched` | Authenticated | MATCHED orders |
| POST | `/orders/:requestId/cancel` | Authenticated | Cancel one bet |
| POST | `/orders/cancel-all` | Authenticated | Cancel all pending |
| POST | `/orders/auto-match/:marketId` | Authenticated | Trigger auto-match |

### Markets (Betfair Live Data)
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/markets/live/cricket` | Live cricket markets |
| GET | `/markets/live/cricket/inplay` | In-play cricket only |
| GET | `/markets/live/football` | Live football markets |
| GET | `/markets/live/tennis` | Live tennis markets |
| GET | `/markets/live/horse` | US horse racing |
| GET | `/markets/live/greyhound` | Greyhound racing |
| GET | `/markets/live/sports/:id` | Single market or sport |
| GET | `/markets/Data?id=<marketId>` | Odds ladder format |
| GET | `/markets/catalog2?id=<marketId>` | Full market catalogue |
| GET | `/markets/Navigation?id=&type=` | Navigation tree |

---

## 🔐 Role Hierarchy

```
SuperAdmin → Admin → SuperMaster → Master → User
```

Each role can only create roles below it.

---

## 🔌 Socket.IO Events

| Event (client → server) | Payload | Description |
|--------------------------|---------|-------------|
| `JoinMatch` | `matchId` | Subscribe to market room |
| `JoinUserRoom` | `userId` | Subscribe to personal wallet updates |
| `updateMarket` | `{ marketId, selectionId }` | Trigger auto-match + broadcast odds |

| Event (server → client) | Description |
|--------------------------|-------------|
| `ordersUpdated` | Bet match status changed |
| `userUpdated` | Wallet / liability changed |
| `marketOddsUpdated` | Market odds broadcast |

---

## 🛡️ Security

- `helmet` – Secure HTTP headers
- `express-rate-limit` – 100 req / 15 min per IP (configurable)
- `bcryptjs` (cost factor 12) – Password hashing  
- JWT with configurable expiry  
- Role-Based Access Control on every route  
- Parameterised queries via Sequelize (SQL injection prevention)

---

## 📋 Environment Variables

See `.env.example` for the full list with descriptions.
