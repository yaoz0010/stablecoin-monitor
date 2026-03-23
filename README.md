# stablecoin-monitor

抓取 USDS 和 GHO 的公开接口数据，按“相对前一周期下滑超过 2%”的规则判断是否告警，并通过飞书自定义机器人卡片推送到群里。项目默认适配 GitHub Actions，也提供了 Render Cron Job 部署方式。

## 已实现范围

- USDS
  - `https://info-sky.blockanalitica.com/overall/?days_ago=1`
    - 取 `total`
    - 展示名: `Total Supply`
  - `https://info-sky.blockanalitica.com/groups/overall/?days_ago=1`
    - 取 `collateral_ratio`、`revenue`
    - 展示名: `Collateral Ratio`、`Estimated Annual Revenue`
  - 运行频率: 每 15 分钟
  - 告警规则: 相对 `t-1` 下滑超过 `2%` 时 `@所有人`
  - 正常与异常都会推送到群里

- GHO
  - `gho_collateral_ratio`
    - 取最新一日与前一日的 `collat_ratio`
  - `gho_liquidity_panel`
    - 取 `gho_in_liquidity_pools` 和 `gho_in_liquidity_pools_yesterday`
  - 运行频率: 每天上午 9 点
  - 告警规则: 相对前一日下滑超过 `2%` 时 `@所有人`

## 环境变量

复制 `.env.example` 为 `.env.local` 或直接在系统环境变量 / GitHub Secrets 中配置:

```env
LARK_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/...
ALERT_DROP_THRESHOLD=0.02
HTTP_TIMEOUT_SECONDS=20
STATE_BACKEND=file
STATE_REDIS_URL=
STATE_KEY_PREFIX=stablecoin-monitor
DRY_RUN=false
```

说明:

- `LARK_WEBHOOK_URL`: 必填，飞书自定义机器人 webhook
- `ALERT_DROP_THRESHOLD`: 默认 `0.02`，代表下滑超过 2% 告警
- `HTTP_TIMEOUT_SECONDS`: 默认 `20`
- `STATE_BACKEND`: `file` / `redis` / `none`
- `STATE_REDIS_URL`: 当 `STATE_BACKEND=redis` 时必填
- `STATE_KEY_PREFIX`: Redis 键名前缀
- `DRY_RUN`: 设为 `true` 时只打印 payload，不发消息

## 本地运行

在仓库根目录执行:

```bash
python -m stablecoin_monitor usds --dry-run
python -m stablecoin_monitor gho --dry-run
python -m stablecoin_monitor all --dry-run
```

## GitHub Actions

已内置两个工作流:

- `USDS Monitor`
  - `7,22,37,52 * * * *`
  - 每 15 分钟运行一次，避开整刻高峰
- `GHO Monitor`
  - `0 1 * * *`
  - GitHub Actions 使用 UTC，这里对应北京时间 `09:00`

推到 GitHub 后，只需要在仓库 `Settings > Secrets and variables > Actions` 中添加:

- `LARK_WEBHOOK_URL`

然后启用 Actions 即可。

## Render

仓库根目录已提供 [render.yaml](/d:/学习/课外/stablecoin-monitor/render.yaml)，用于把高频的 USDS 任务迁到 Render Cron Job。

当前 Blueprint 定义了两个 Render 资源:

- `stablecoin-monitor-usds`
  - Render Cron Job
  - 调度: `7,22,37,52 * * * *`
  - 执行命令: `python -m stablecoin_monitor usds`
- `stablecoin-monitor-state`
  - Render Key Value
  - 用于保存告警状态，避免每次运行都把已有告警重复当成“新增告警”

部署步骤:

1. 在 Render 中选择 `New +` -> `Blueprint`
2. 连接这个 GitHub 仓库
3. 选择 `main` 分支并导入 `render.yaml`
4. 在 Blueprint 创建流程里填入 `LARK_WEBHOOK_URL`
5. 创建完成后，Render 会同时创建 USDS Cron Job 和 Key Value

说明:

- Render Key Value 官方文档说明，`connectionString` 可以通过 Blueprint `fromService` 注入；Key Value 也支持 Redis 协议连接
- Render Key Value 的 `free` 实例不落盘持久化，实例重启后可能丢状态；如果你希望告警去重更稳，建议把 Key Value 升级到带持久化的付费实例
- GHO 这种每天一次的任务仍然更适合继续留在 GitHub Actions

## 消息与告警行为

- 消息以飞书卡片形式发送
- 正常情况下也会推送到群里
- 只有“新进入告警”的指标才会 `@所有人`
- 首次启动或首次手动运行时，如果指标本来就已经低于阈值，只记录为“首次运行已发现告警”，不会直接 `@所有人`
- 如果某指标持续多次处于告警区间，会显示为“持续告警”，但不会每次重复 `@所有人`
- 数值展示尽量保持接口原始格式
- `Collateral Ratio` / `collat_ratio` 统一按百分比展示
