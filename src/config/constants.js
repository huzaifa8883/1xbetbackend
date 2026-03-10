'use strict';

module.exports = {
  /* ── Roles ──────────────────────────────────────────────── */
  ROLES: {
    SUPERADMIN: 'SuperAdmin',
    ADMIN: 'Admin',
    SUPER_MASTER: 'SuperMaster',
    MASTER: 'Master',
    USER: 'User',
  },

  ROLE_HIERARCHY: {
    SuperAdmin: 5,
    Admin: 4,
    SuperMaster: 3,
    Master: 2,
    User: 1,
  },

  /** Which roles each role is allowed to create */
  CREATION_PERMISSIONS: {
    SuperAdmin: ['Admin', 'SuperMaster', 'Master', 'User'],
    Admin: ['SuperMaster', 'Master', 'User'],
    SuperMaster: ['Master', 'User'],
    Master: ['User'],
    User: [],
  },

  /* ── Order / Bet Statuses ───────────────────────────────── */
  ORDER_STATUS: {
    PENDING: 'PENDING',
    MATCHED: 'MATCHED',
    CANCELLED: 'CANCELLED',
    SETTLED: 'SETTLED',
  },

  BET_SIDE: {
    BACK: 'B',
    LAY: 'L',
  },

  /* ── Transaction Types ──────────────────────────────────── */
  TRANSACTION_TYPE: {
    DEPOSIT: 'deposit',
    WITHDRAWAL: 'withdrawal',
    BET_PLACED: 'BET_PLACED',
    BET_CANCELLED: 'BET_CANCELLED',
    BET_CANCELLED_ALL: 'BET_CANCELLED_ALL',
    BET_SETTLEMENT: 'BET_SETTLEMENT',
    CREDIT_DEPOSIT: 'credit-deposit',
    CREDIT_WITHDRAWAL: 'credit-withdrawal',
  },

  /* ── Betfair Sport Map ──────────────────────────────────── */
  SPORT_MAP: {
    '1': 'Soccer',
    '2': 'Tennis',
    '4': 'Cricket',
    '7': 'Horse Racing',
    '4339': 'Greyhound Racing',
    '7524': 'Basketball',
    '7522': 'Ice Hockey',
    '468328': 'Volleyball',
  },

  /* ── HTTP Status Codes (convenience) ───────────────────── */
  HTTP: {
    OK: 200,
    CREATED: 201,
    ACCEPTED: 202,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    INTERNAL_SERVER_ERROR: 500,
  },
};
