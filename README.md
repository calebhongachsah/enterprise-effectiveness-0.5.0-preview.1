# 企业效能运营平台

单流程、自托管的效能运营平台。从 CSV 或只读 PostgreSQL 接入数据，配置流程和 SLA，查看看板、下钻异常、收集原因并跟进改进。每套实例可以由一位运营负责人完成日常操作。

## 运行预览版

1. 准备 Docker Engine 和 Docker Compose，进入 `项目代码库`。
2. 将 `infra/.env.example` 复制为 `infra/.env`，为数据库设置独立强密码并更新两个数据库 URL。用 `openssl rand -base64 32` 生成 `DATA_SOURCE_MASTER_KEY`，用 `openssl rand -hex 32` 生成 `ADMIN_BOOTSTRAP_TOKEN`。
3. 启动应用和 PostgreSQL。

   ```sh
   docker compose --env-file infra/.env -f infra/docker-compose.yml up --build --wait
   ```

4. 打开 `http://127.0.0.1:8787`，填写部署令牌并创建首个管理员。登录后可从配置文件移除令牌并重新运行上面的命令。
5. 上传 `项目代码库/data/software-development-demo-utf8.csv` 并发布批次。该模拟样本包含 48 条研发事项。

[安装、安全配置、升级与恢复](项目代码库/infra/README.md) · [本地开发与测试](项目代码库/README.md)

这是单流程预览版。对外或企业内网部署时使用 HTTPS 反向代理，启用 Secure 会话 Cookie，并定期备份数据库与单独保存数据源主密钥。安装配置由部署者管理，无需向项目方申请激活码。

## 开源授权

本项目按 [Apache-2.0](LICENSE) 发布。版权及第三方组件信息见 [NOTICE](NOTICE) 和[第三方声明](THIRD-PARTY-NOTICES.md)。
