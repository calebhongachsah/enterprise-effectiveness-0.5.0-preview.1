import {
  closePostgres,
  migratePostgres,
  migrationsDirectory,
} from "../apps/api/src/postgres.js";

try {
  const applied = await migratePostgres();
  console.log(`PostgreSQL 迁移完成：${applied.join(", ")}`);
  console.log(`迁移来源：${migrationsDirectory}`);
} finally {
  await closePostgres();
}
