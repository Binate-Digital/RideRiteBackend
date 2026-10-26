/**
 * Admin role-based access control (TRD 6.1).
 *
 * Every admin user (`role: "admin"`) has an `adminRole`; each admin route requires one or
 * more permissions (see requirePermission in middleware/auth.js). Admins created before RBAC
 * have no adminRole and are treated as super_admin (migrated on read, see effectiveAdminRole).
 */

export const ADMIN_ROLES = ["super_admin", "ops", "finance", "support"];

export const PERMISSIONS = [
  "dashboard:read",
  "users:read",
  "users:manage", // role changes, suspend / deactivate / reactivate
  "users:export",
  "users:gdpr", // export a user's data, delete / anonymize
  "drivers:read",
  "drivers:approve", // account, document and vehicle-change review
  "drivers:documents", // open a driver's private documents (license, registration, insurance)
  "trips:read",
  "trips:refund",
  "trips:chat", // read a trip's chat transcript (disputes only)
  "disputes:manage",
  "rentals:read",
  "rentals:manage",
  "chauffeur:read",
  "finance:read",
  "finance:payouts",
  "finance:refunds",
  "bonuses:manage",
  "maintenance:manage",
  "promos:manage",
  "settings:read",
  "settings:write",
  "legal:write", // edit Terms / Privacy / Refund policy / EULA pages
  "audit:read",
  "health:read",
  "admins:manage",
];

const READ_ALL = ["dashboard:read", "users:read", "drivers:read", "trips:read", "rentals:read", "chauffeur:read"];

export const ROLE_PERMISSIONS = {
  super_admin: [...PERMISSIONS],
  /** Operations: drivers, users, trips, disputes, rentals, bonuses, maintenance */
  ops: [
    ...READ_ALL,
    "users:manage",
    "users:export",
    "drivers:approve",
    "drivers:documents",
    "trips:chat",
    "disputes:manage",
    "rentals:manage",
    "bonuses:manage",
    "maintenance:manage",
    "settings:read",
    "health:read",
  ],
  /** Finance: revenue, payouts, refunds, subscriptions, promos, fee settings */
  finance: [
    ...READ_ALL,
    "users:export",
    "trips:refund",
    "finance:read",
    "finance:payouts",
    "finance:refunds",
    "bonuses:manage",
    "promos:manage",
    "settings:read",
    "audit:read",
  ],
  /** Support: look things up and work the dispute queue (no money movement) */
  support: [...READ_ALL, "trips:chat", "disputes:manage"],
};

export const ADMIN_ROLE_LABELS = {
  super_admin: "Super admin",
  ops: "Operations",
  finance: "Finance",
  support: "Support",
};

/** An admin's role; legacy admins without one are super_admin. Non-admins → null. */
export function effectiveAdminRole(user) {
  if (!user || user.role !== "admin") return null;
  return ADMIN_ROLES.includes(user.adminRole) ? user.adminRole : "super_admin";
}

export function permissionsFor(user) {
  const role = effectiveAdminRole(user);
  return role ? ROLE_PERMISSIONS[role] : [];
}

export function hasPermission(user, permission) {
  return permissionsFor(user).includes(permission);
}
