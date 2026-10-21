// Runs once, on the first start of the mongo container (as the root user).
// Creates the platform's provisioning identity. It is NOT root: it can manage databases and
// users but cannot change cluster configuration. Student queries never use it; with
// WORKSPACE_DB_USERS=true each workspace gets its own user limited to that one database.
const admin = db.getSiblingDB('admin');
const user = process.env.PLATFORM_ADMIN_USER || 'practice_admin';
if (!admin.getUser(user)) {
  admin.createUser({
    user,
    pwd: process.env.PLATFORM_ADMIN_PASSWORD || 'change-me-admin',
    roles: ['readWriteAnyDatabase', 'dbAdminAnyDatabase', 'userAdminAnyDatabase'],
  });
  print(`Created platform user ${user}`);
}
