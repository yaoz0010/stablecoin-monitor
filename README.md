# stablecoin-monitor

当前线上运行方案是 `Cloudflare Workers`。仓库里保留了一份 Python 版本用于本地调试和接口核对，但生产定时任务已经不再依赖 GitHub Actions 或 Render。

## 当前行为

### USDS

- 数据源
  - `https://info-sky.blockanalitica.com/overall/?days_ago=1`
    - 取 `total`
    - 展示名：`Total Supply`
  - `https://info-sky.blockanalitica.com/groups/overall/?days_ago=1`
    - 取 `collateral_ratio`、`revenue`
    - 展示名：`Collateral Ratio`、`Estimated Annual Revenue`
- 调度：每 15 分钟一次
  - Cron: `7,22,37,52 * * * *`
- 告警规则
  - 对比上一条 15 分钟快照
  - 任一指标下滑超过 `1%` 时发送飞书卡片
  - 告警时直接 `@所有人`
  - 不告警就不推送
- 备注
  - 首次运行只初始化快照，不发消息

### GHO

- 数据源
  - `gho_collateral_ratio`
    - 取最新一日与前一日的 `collat_ratio`
  - `gho_liquidity_panel`
    - 取 `gho_in_liquidity_pools` 和 `gho_in_liquidity_pools_yesterday`
- 调度：每天北京时间 `12:00`
  - Cron: `0 4 * * *`
- 告警规则
  - 相对前一日下滑超过 `2%` 时 `@所有人`
  - 继续使用状态去重，避免同一告警重复 `@所有人`

## 仓库结构

- [stablecoin_monitor](/d:/学习/课外/stablecoin-monitor/stablecoin_monitor)
  - Python 版本，仅用于本地 dry-run、接口验证和备份实现
- [worker/usds](/d:/学习/课外/stablecoin-monitor/worker/usds)
  - 当前线上 Worker
  - 同时负责 USDS 和 GHO

## Cloudflare Worker

关键文件：

- [worker/usds/wrangler.jsonc](/d:/学习/课外/stablecoin-monitor/worker/usds/wrangler.jsonc)
- [worker/usds/src/index.js](/d:/学习/课外/stablecoin-monitor/worker/usds/src/index.js)
- [worker/usds/package.json](/d:/学习/课外/stablecoin-monitor/worker/usds/package.json)

当前 Cloudflare 配置：

- Cron Triggers
  - `7,22,37,52 * * * *` for USDS
  - `0 4 * * *` for GHO
- KV binding
  - `STATE_KV`
- Secret
  - `LARK_WEBHOOK_URL`
- 可选 Secret
  - `MANUAL_TRIGGER_TOKEN`
- Plaintext vars
  - `USDS_ALERT_DROP_THRESHOLD=0.01`
  - `GHO_ALERT_DROP_THRESHOLD=0.02`
  - `HTTP_TIMEOUT_MS=20000`
  - `STATE_KEY_PREFIX=stablecoin-monitor`

手动调试入口：

- `GET /health`
- `GET /run/usds`
- `GET /run/gho`

如果设置了 `MANUAL_TRIGGER_TOKEN`，请求时带上：

- `Authorization: Bearer <token>`
- 或 `?token=<token>`

## 本地 Python

本地运行时可以用仓库根目录的 [.env.example](/d:/学习/课外/stablecoin-monitor/.env.example) 作为模板：

```env
LARK_WEBHOOK_URL=
ALERT_DROP_THRESHOLD=0.02
HTTP_TIMEOUT_SECONDS=20
DRY_RUN=false
```

本地命令：

```bash
python -m stablecoin_monitor usds --dry-run
python -m stablecoin_monitor gho --dry-run
python -m stablecoin_monitor all --dry-run
```

说明：

- Python 版不会自动部署到线上
- 现在它主要用于本地验证接口和消息格式
- Python 版仍然保留原来的日级比较逻辑，不等同于线上 USDS 的 15 分钟快照逻辑

## 已删除的旧方案

以下方案已经不再使用，相关部署文件已移除：

- GitHub Actions 定时任务
- Render Cron Job / Key Value
