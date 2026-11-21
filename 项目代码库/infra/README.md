# PostgreSQL 与 Docker Compose 基础设施

本目录承载正式产品的 PostgreSQL 基线。API 配置 `DATABASE_URL` 后会完整使用 PostgreSQL 业务存储；未配置时继续使用 `data/demo.sqlite`，便于保留现有单机演示方式。两种存储按启动配置二选一，不会在同一实例中混合读写。

## 已纳入版本管理

- `migrations/`：按编号顺序执行的 PostgreSQL 迁移，包含 V0.2 当前全部业务表和查询索引。
- `docker-compose.yml`：单机试点/客户受控环境的应用与 PostgreSQL 17 一体启动基线。
- `.env.example`：环境变量示例，不含真实密码。
- `npm run validate:infra`：不依赖数据库的迁移完整性检查。
- `npm run migrate:postgres`：连接真实数据库，串行执行尚未登记的迁移。
- `npm run test:postgres` 使用 `POSTGRES_TEST_DATABASE_URL` 启动真实 API，重建专用测试数据并验证业务链和权限。这是破坏性测试，数据库名必须以 `_test` 结尾。
- `npm run test:postgres:upgrade` 使用 `POSTGRES_UPGRADE_TEST_DATABASE_URL` 在另一个以 `_test` 结尾的空数据库建立 V0.3 示例，然后验证升级、重复启动及历史数据保留。
- `npm run backup:postgres`：生成数据库、部署配置、迁移和校验清单组成的同批次备份。
- `npm run restore:postgres -- backups/<备份编号> --confirm-maintenance`：校验备份后在维护状态恢复并执行完整性检查。

## 在具备 Docker 的机器上初始化

1. 将 `.env.example` 复制为 `.env`。生成数据库密码并在三个数据库配置项中使用同一密码。用 `openssl rand -base64 32` 生成 `DATA_SOURCE_MASTER_KEY`，用 `openssl rand -hex 32` 生成 `ADMIN_BOOTSTRAP_TOKEN`。
2. 在代码库根目录运行 `docker compose --env-file infra/.env -f infra/docker-compose.yml up --build --wait`，同时构建并启动应用和数据库。
3. 打开 `http://127.0.0.1:8787`，用部署令牌创建唯一的运营负责人账号。确认登录后，从 `.env` 移除令牌并重建应用容器。
4. 进入「数据与流程」，上传 `data/software-development-demo-utf8.csv`，生成并发布批次。也可以配置专用的只读 PostgreSQL 数据源。
5. 企业内网访问使用 HTTPS 反向代理，并设置 `SESSION_COOKIE_SECURE=true`。应用和数据库的默认对外端口均绑定本机。恢复已保存的外部数据源凭据时需要原主密钥。

也可以在项目代码库根目录配置 `DATABASE_URL` 后运行 `npm run migrate:postgres`。迁移器使用 PostgreSQL 会话锁避免两个应用实例同时升级结构；已经登记的版本会跳过。

迁移脚本设计为可重复执行，但已经存在的数据卷不会自动重跑初始化目录。应用启动时会在接受请求前执行尚未登记的迁移。

## 当前边界

- 2026-10-06 已在 Apple M5 MacBook、Docker Desktop 4.94.0 和 PostgreSQL 17 Alpine 上完成实机初始化、迁移命令及容器重启持久化验证。
- API 启动时如果存在 `DATABASE_URL`，会先连接 PostgreSQL 并执行迁移；失败则拒绝启动。健康检查会返回连接与迁移状态。
- 配置 `DATABASE_URL` 时，健康检查返回 `storage: postgresql`；未配置时返回 `storage: sqlite-demo`。
- 2026-10-06 已用独立真实测试库验证全量导入、重复导入、增量发布、配置版本、团队 SLA、看板聚合和改善闭环；测试结束后业务数据自动清空。
- PostgreSQL 正式模式已具备账号权限、追加审计、备份和恢复；生产级指标采集与告警仍在 V0.2 后续工作中。

## 备份与恢复

执行备份：

```sh
npm run backup:postgres
```

备份写入代码库内被 Git 忽略的 `backups/<UTC 时间>/`，包含自定义格式数据库转储、Docker Compose、环境变量示例、全部迁移和 `manifest.json`。清单记录数据库、数据量和每个文件的 SHA-256；`BACKUP_RETENTION_COUNT` 控制保留份数，默认 14。

恢复前必须停止应用，使健康检查不可访问；数据库容器保持运行。然后执行：

```sh
npm run restore:postgres -- backups/<备份编号> --confirm-maintenance
```

恢复命令只接受项目 `backups/` 内的目录，拒绝数据库名称不一致或校验值不一致的备份。完成后自动核对迁移、批次、事项、配置版本和用户数量，并追加恢复审计事件。恢复成功后再启动应用。
