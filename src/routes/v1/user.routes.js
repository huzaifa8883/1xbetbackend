'use strict';

const { Router } = require('express');
const ctrl = require('../../controllers/user.controller');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { createUserRules, transactionRules, creditTransactionRules } = require('../../validators');
const { ROLES } = require('../../config/constants');

const router = Router();

// All routes require authentication
router.use(authenticate());

// ── Dashboard & overview ──────────────────────────────────────
// IMPORTANT: These MUST be before /:id to prevent Express matching
// "dashboard" as an ID parameter
router.get('/dashboard',         ctrl.getDashboardStats);
router.get('/all-balances',      ctrl.getAllBalances);
router.get('/activity-log',      ctrl.getActivityLog);
router.get('/all-transactions',  ctrl.getAllTransactions);

// ── Role-based lists ──────────────────────────────────────────
router.get('/masters',           ctrl.listByRole('Master'));
router.get('/supermasters',      ctrl.listByRole('SuperMaster'));
router.get('/admin',             ctrl.listByRole('Admin'));
router.get('/user',              ctrl.listByRole('User'));

// ── Me & downline ─────────────────────────────────────────────
router.get('/me',                ctrl.getMe);
router.get('/downline',          ctrl.getDownline);

// ── Transactions ──────────────────────────────────────────────
router.post('/transaction',        transactionRules, validate, ctrl.processTransaction);
router.post('/credit-transaction', creditTransactionRules, validate, ctrl.processCreditTransaction);

// ── Create user ───────────────────────────────────────────────
router.post('/',       createUserRules, validate, ctrl.createUser);
router.post('/create', createUserRules, validate, ctrl.createUser); // legacy alias

// ── List all users (Admin+) ───────────────────────────────────
router.get('/', authenticate(ROLES.ADMIN), ctrl.listUsers);

// ── Per-user CRUD — /:id MUST come last ──────────────────────
router.get('/:id/transactions',  ctrl.getUserTransactions);
router.get('/:id',               ctrl.getUser);
router.put('/:id',               ctrl.updateUser);
router.delete('/:id',            authenticate(ROLES.ADMIN), ctrl.deleteUser);

module.exports = router;
