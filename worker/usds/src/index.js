import Decimal from "decimal.js";

const USDS_OVERALL_URL =
  "https://info-sky.blockanalitica.com/overall/?days_ago=1";
const USDS_GROUPS_URL =
  "https://info-sky.blockanalitica.com/groups/overall/?days_ago=1";
const GHO_COLLATERAL_RATIO_URL =
  "https://aave.tokenlogic.xyz/api/gho_tokenlogic?table=gho_collateral_ratio";
const GHO_LIQUIDITY_PANEL_URL =
  "https://aave.tokenlogic.xyz/api/gho_tokenlogic?table=gho_liquidity_panel";
const STATE_SUFFIX = "alert-state";
const SNAPSHOT_SUFFIX = "snapshot";
const USDS_CRON = "7,22,37,52 * * * *";
const GHO_CRON = "0 4 * * *";

export default {
  async scheduled(controller, env, ctx) {
    switch (controller.cron) {
      case USDS_CRON:
        ctx.waitUntil(runUsdsMonitor(env, { source: "cron" }));
        break;
      case GHO_CRON:
        ctx.waitUntil(runGhoMonitor(env, { source: "cron" }));
        break;
      default:
        ctx.waitUntil(
          Promise.reject(new Error(`Unhandled cron trigger: ${controller.cron}`))
        );
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "stablecoin-monitor-usds-worker" });
    }

    if (url.pathname === "/run/usds") {
      const authResponse = validateManualTriggerToken(request, env);
      if (authResponse) {
        return authResponse;
      }
      const result = await runUsdsMonitor(env, {
        source: "http",
        persistState: true,
        sendMessage: true,
      });
      return jsonResponse(result);
    }

    if (url.pathname === "/run/gho") {
      const authResponse = validateManualTriggerToken(request, env);
      if (authResponse) {
        return authResponse;
      }
      const result = await runGhoMonitor(env, {
        source: "http",
        persistState: true,
        sendMessage: true,
      });
      return jsonResponse(result);
    }

    return jsonResponse(
      {
        ok: false,
        error: "Not found",
        available_paths: ["/health", "/run/usds", "/run/gho"],
      },
      404
    );
  },
};

async function runUsdsMonitor(
  env,
  {
    source,
    persistState = true,
    sendMessage = true,
  } = {}
) {
  const timeoutMs = parseInteger(env.HTTP_TIMEOUT_MS, 20000);
  const thresholdRatio = new Decimal(env.ALERT_DROP_THRESHOLD || "0.02");

  const [overall, groups] = await Promise.all([
    fetchJson(USDS_OVERALL_URL, timeoutMs),
    fetchJson(USDS_GROUPS_URL, timeoutMs),
  ]);

  const currentSnapshot = {
    captured_at: new Date().toISOString(),
    total: String(overall.total),
    collateral_ratio: String(groups.collateral_ratio),
    revenue: String(groups.revenue),
  };
  const previousSnapshot = await readSnapshot(env, "USDS");

  if (!previousSnapshot) {
    await writeSnapshot(env, "USDS", currentSnapshot);
    return {
      ok: true,
      source,
      summaryTime: overall.date,
      status: "initialized",
      message: "USDS snapshot initialized. No alert was sent.",
    };
  }

  const metrics = [
    buildMetricFromValues({
      name: "Total Supply",
      currentRaw: overall.total,
      baselineRaw: previousSnapshot.total,
      thresholdRatio,
      asPercent: false,
    }),
    buildMetricFromValues({
      name: "Collateral Ratio",
      currentRaw: groups.collateral_ratio,
      baselineRaw: previousSnapshot.collateral_ratio,
      thresholdRatio,
      asPercent: true,
    }),
    buildMetricFromValues({
      name: "Estimated Annual Revenue",
      currentRaw: groups.revenue,
      baselineRaw: previousSnapshot.revenue,
      thresholdRatio,
      asPercent: false,
    }),
  ];

  const result = {
    sourceName: "USDS",
    summaryTime: overall.date,
    baselineLabel: "上一周期",
    ruleDescription: "相对上一周期（约15min）",
    note:
      `上一周期快照时间: ${previousSnapshot.captured_at}; ` +
      "数据源: overall/?days_ago=1 与 groups/overall/?days_ago=1",
    metrics,
    alertNames: metrics.filter((metric) => metric.isAlert).map((metric) => metric.name),
    newAlertNames: metrics
      .filter((metric) => metric.isAlert)
      .map((metric) => metric.name),
    recoveredAlertNames: [],
    priorStateFound: true,
  };

  if (result.alertNames.length > 0 && sendMessage) {
    const payload = buildCardPayload(result, thresholdRatio);
    await sendMessageToLark(env.LARK_WEBHOOK_URL, payload, timeoutMs);
  }

  if (persistState) {
    await writeSnapshot(env, "USDS", currentSnapshot);
  }

  return {
    ok: true,
    source,
    summaryTime: result.summaryTime,
    status: result.alertNames.length > 0 ? "alert_sent" : "no_alert_no_push",
    alertNames: result.alertNames,
    baselineTime: previousSnapshot.captured_at,
  };
}

async function runGhoMonitor(
  env,
  {
    source,
    persistState = true,
    sendMessage = true,
  } = {}
) {
  const timeoutMs = parseInteger(env.HTTP_TIMEOUT_MS, 20000);
  const thresholdRatio = new Decimal(env.ALERT_DROP_THRESHOLD || "0.02");

  const [collateralResponse, liquidityResponse] = await Promise.all([
    fetchJson(GHO_COLLATERAL_RATIO_URL, timeoutMs),
    fetchJson(GHO_LIQUIDITY_PANEL_URL, timeoutMs),
  ]);

  const [latestRow, previousRow] = latestTwoCollateralRows(collateralResponse.data || []);
  const liquidityRow = (liquidityResponse.data || [])[0];
  if (!liquidityRow) {
    throw new Error("gho_liquidity_panel returned no rows.");
  }

  const latestDay = latestRow.block_day.value;
  const previousDay = previousRow.block_day.value;

  const metrics = [
    buildMetricFromValues({
      name: "Collateral Ratio",
      currentRaw: latestRow.collat_ratio,
      baselineRaw: previousRow.collat_ratio,
      thresholdRatio,
      asPercent: true,
    }),
    buildMetricFromValues({
      name: "GHO in Liquidity Pools",
      currentRaw: liquidityRow.gho_in_liquidity_pools,
      baselineRaw: liquidityRow.gho_in_liquidity_pools_yesterday,
      thresholdRatio,
      asPercent: false,
    }),
  ];

  let result = {
    sourceName: "GHO",
    summaryTime: latestDay,
    baselineLabel: "前一日",
    ruleDescription: "相对前一日",
    note:
      `Collateral Ratio 对比: ${latestDay} vs ${previousDay}; ` +
      "Liquidity 对比: gho_in_liquidity_pools vs gho_in_liquidity_pools_yesterday",
    metrics,
    alertNames: metrics.filter((metric) => metric.isAlert).map((metric) => metric.name),
    newAlertNames: [],
    recoveredAlertNames: [],
    priorStateFound: false,
  };

  result = await applyAlertState(result, env, { persistState });

  const payload = buildCardPayload(result, thresholdRatio);
  if (sendMessage) {
    await sendMessageToLark(env.LARK_WEBHOOK_URL, payload, timeoutMs);
  }
  if (persistState) {
    await persistAlertState(env, result);
  }

  return {
    ok: true,
    source,
    summaryTime: result.summaryTime,
    status: buildStatusText(result),
    alertNames: result.alertNames,
    newAlertNames: result.newAlertNames,
    recoveredAlertNames: result.recoveredAlertNames,
    priorStateFound: result.priorStateFound,
  };
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "stablecoin-monitor-usds-worker/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${url} returned ${response.status}`);
  }

  return response.json();
}

function buildMetricFromChangeField({
  name,
  currentRaw,
  changeRatioRaw,
  thresholdRatio,
  asPercent,
}) {
  const current = toDecimal(currentRaw);
  const changeRatio = toDecimal(changeRatioRaw);
  const baseline = current.div(new Decimal(1).plus(changeRatio));

  return {
    name,
    currentDisplay: formatMetricValue(currentRaw, { asPercent }),
    baselineDisplay: formatMetricValueLike(baseline, currentRaw, { asPercent }),
    changeDisplay: formatChangePercent(changeRatio),
    isAlert: changeRatio.lte(thresholdRatio.neg()),
  };
}

function buildMetricFromValues({
  name,
  currentRaw,
  baselineRaw,
  thresholdRatio,
  asPercent,
}) {
  const current = toDecimal(currentRaw);
  const baseline = toDecimal(baselineRaw);
  if (baseline.eq(0)) {
    throw new Error(`${name} baseline value is zero; cannot compute change ratio.`);
  }
  const changeRatio = current.minus(baseline).div(baseline);

  return {
    name,
    currentDisplay: formatMetricValue(currentRaw, { asPercent }),
    baselineDisplay: formatMetricValue(baselineRaw, { asPercent }),
    changeDisplay: formatChangePercent(changeRatio),
    isAlert: changeRatio.lte(thresholdRatio.neg()),
  };
}

async function applyAlertState(result, env, { persistState }) {
  const previous = await readState(env, result.sourceName);
  const currentAlertNames = new Set(result.alertNames);
  let newAlertNames = difference(currentAlertNames, previous.alertNames);
  let recoveredAlertNames = difference(previous.alertNames, currentAlertNames);

  if (!previous.found) {
    newAlertNames = [];
    recoveredAlertNames = [];
  }

  const updated = {
    ...result,
    newAlertNames: newAlertNames.sort(),
    recoveredAlertNames: recoveredAlertNames.sort(),
    priorStateFound: previous.found,
  };

  return updated;
}

function latestTwoCollateralRows(rows) {
  const rowsByDay = new Map();
  for (const row of rows) {
    if (row?.block_day?.value) {
      rowsByDay.set(row.block_day.value, row);
    }
  }

  const orderedDays = [...rowsByDay.keys()].sort();
  if (orderedDays.length < 2) {
    throw new Error("Not enough daily rows in gho_collateral_ratio.");
  }

  return [
    rowsByDay.get(orderedDays[orderedDays.length - 1]),
    rowsByDay.get(orderedDays[orderedDays.length - 2]),
  ];
}

async function persistAlertState(env, result) {
  await writeState(env, result.sourceName, {
    source_name: result.sourceName,
    summary_time: result.summaryTime,
    alert_names: [...result.alertNames].sort(),
  });
}

async function readState(env, sourceName) {
  const raw = await env.STATE_KV.get(stateKey(env, sourceName));
  if (!raw) {
    return { found: false, alertNames: new Set() };
  }

  const data = JSON.parse(raw);
  return {
    found: true,
    alertNames: new Set(data.alert_names || []),
  };
}

async function writeState(env, sourceName, payload) {
  await env.STATE_KV.put(stateKey(env, sourceName), JSON.stringify(payload));
}

function stateKey(env, sourceName) {
  const prefix = env.STATE_KEY_PREFIX || "stablecoin-monitor";
  return `${prefix}:${sourceName.toLowerCase()}:${STATE_SUFFIX}`;
}

async function readSnapshot(env, sourceName) {
  const raw = await env.STATE_KV.get(snapshotKey(env, sourceName));
  return raw ? JSON.parse(raw) : null;
}

async function writeSnapshot(env, sourceName, payload) {
  await env.STATE_KV.put(snapshotKey(env, sourceName), JSON.stringify(payload));
}

function snapshotKey(env, sourceName) {
  const prefix = env.STATE_KEY_PREFIX || "stablecoin-monitor";
  return `${prefix}:${sourceName.toLowerCase()}:${SNAPSHOT_SUFFIX}`;
}

function buildCardPayload(result, thresholdRatio) {
  const elements = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          `**时间**: ${result.summaryTime}\n` +
          `**规则**: ${result.ruleDescription} 下滑超过 ${formatThresholdPercent(
            thresholdRatio
          )} 告警`,
      },
    },
  ];

  if (result.newAlertNames.length > 0) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `<at id=all></at> **新增告警项**: ${result.newAlertNames.join(", ")}`,
      },
    });
  } else if (result.alertNames.length > 0) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: result.priorStateFound
          ? `**说明**: 当前仍处于告警中的指标: ${result.alertNames.join(", ")}`
          : "**说明**: 首次运行仅记录状态，不触发 @所有人",
      },
    });
  } else if (result.recoveredAlertNames.length > 0) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**恢复项**: ${result.recoveredAlertNames.join(", ")}`,
      },
    });
  }

  elements.push({ tag: "hr" });

  for (const metric of result.metrics) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          `**${metric.name}**  \`${metric.isAlert ? "告警" : "正常"}\`\n` +
          `当前值: ${metric.currentDisplay}\n` +
          `${result.baselineLabel}: ${metric.baselineDisplay}\n` +
          `变化: ${metric.changeDisplay}`,
      },
    });
  }

  elements.push(
    { tag: "hr" },
    {
      tag: "note",
      elements: [{ tag: "plain_text", content: result.note }],
    }
  );

  return {
    msg_type: "interactive",
    card: {
      config: {
        wide_screen_mode: true,
        enable_forward: true,
      },
      header: {
        template: buildHeaderTemplate(result),
        title: {
          tag: "plain_text",
          content: `${result.sourceName} Monitor | ${buildStatusText(result)}`,
        },
      },
      elements,
    },
  };
}

function buildStatusText(result) {
  if (result.newAlertNames.length > 0) {
    return "新增告警";
  }
  if (result.alertNames.length > 0 && result.priorStateFound) {
    return "持续告警";
  }
  if (result.alertNames.length > 0) {
    return "首次运行已发现告警";
  }
  if (result.recoveredAlertNames.length > 0) {
    return "告警恢复";
  }
  return "正常";
}

function buildHeaderTemplate(result) {
  if (result.newAlertNames.length > 0) {
    return "red";
  }
  if (result.alertNames.length > 0 || result.recoveredAlertNames.length > 0) {
    return "orange";
  }
  return "green";
}

async function sendMessageToLark(webhookUrl, payload, timeoutMs) {
  if (!webhookUrl) {
    throw new Error("LARK_WEBHOOK_URL secret is not configured.");
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "stablecoin-monitor-usds-worker/1.0",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Lark webhook returned HTTP ${response.status}`);
  }

  const result = await response.json();
  if (result.code !== undefined && result.code !== 0) {
    throw new Error(`Lark webhook returned an error: ${JSON.stringify(result)}`);
  }
}

function toDecimal(value) {
  return new Decimal(String(value));
}

function formatMetricValue(rawValue, { asPercent }) {
  const rawText = String(rawValue);
  if (!asPercent) {
    return rawText;
  }
  if (typeof rawValue === "string") {
    return `${new Decimal(rawText)
      .mul(100)
      .toFixed(displayPlacesForPercent(rawText))}%`;
  }
  return `${trimZeros(new Decimal(rawText).mul(100).toString())}%`;
}

function formatMetricValueLike(value, template, { asPercent }) {
  const places = decimalPlaces(String(template));
  const displayValue = value.toDecimalPlaces(places);
  if (!asPercent) {
    return displayValue.toFixed(places);
  }
  return `${displayValue
    .mul(100)
    .toFixed(displayPlacesForPercent(String(template)))}%`;
}

function formatChangePercent(changeRatio) {
  const text = trimZeros(changeRatio.mul(100).toDecimalPlaces(6).toFixed(6));
  return text.startsWith("-") ? `${text}%` : `+${text}%`;
}

function formatThresholdPercent(thresholdRatio) {
  return `${trimZeros(thresholdRatio.mul(100).toString())}%`;
}

function decimalPlaces(valueText) {
  const parts = valueText.split(".");
  return parts.length === 2 ? parts[1].length : 0;
}

function displayPlacesForPercent(valueText) {
  return Math.max(decimalPlaces(valueText) - 2, 0);
}

function trimZeros(text) {
  if (!text.includes(".")) {
    return text;
  }
  return text.replace(/\.?0+$/, "");
}

function difference(leftSet, rightSet) {
  const values = [];
  for (const value of leftSet) {
    if (!rightSet.has(value)) {
      values.push(value);
    }
  }
  return values;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function validateManualTriggerToken(request, env) {
  const expected = env.MANUAL_TRIGGER_TOKEN;
  if (!expected) {
    return null;
  }

  const authHeader = request.headers.get("authorization") || "";
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : new URL(request.url).searchParams.get("token") || "";

  if (provided !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
