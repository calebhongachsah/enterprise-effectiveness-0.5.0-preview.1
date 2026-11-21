# 模拟数据

- `software-development-demo-utf8.csv`：V0.1/V0.2 快速功能演示，48 条事项、4 个团队。
- `v02-simulated-pilot-1800-utf8.csv`：V0.2 模拟生产试点基准，12 个月、1,800 条事项、6 个团队，可直接上传平台。
- `generated/v02-pressure-10000-utf8.csv`：由生成命令在本机产生的 10,000 条压力数据，不进入 Git。

重新生成 V0.2 两套数据：

```sh
npm run generate:v02-data
```

生成器使用固定种子，因此相同代码会得到相同数据。所有组织、事项和结果均为虚构。
