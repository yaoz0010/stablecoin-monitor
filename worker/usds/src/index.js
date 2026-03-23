import Decimal from "decimal.js";

const USDS_OVERALL_URL =
  "https://info-sky.blockanalitica.com/overall/?days_ago=1";
const USDS_GROUPS_URL =
  "https://info-sky.blockanalitica.com/groups/overall/?days_ago=1";
const STATE_SUFFIX = "alert-state";

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runUsdsMonitor(env, { source: "cron" }));
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

    return jsonResponse(
      {
        ok: false,
        error: "Not found",
        available_paths: ["/health", "/run/usds"],
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

  const metrics = [
    buildMetricFromChangeField({
      name: "Total Supply",
      currentRaw: overall.total,
      changeRatioRaw: overall.total_change_percentage,
      thresholdRatio,
      asPercent: false,
    }),
    buildMetricFromChangeField({
      name: "Collateral Ratio",
      currentRaw: groups.collateral_ratio,
      changeRatioRaw: groups.collateral_ratio_change_percentage,
      thresholdRatio,
      asPercent: true,
    }),
    buildMetricFromChangeField({
      name: "Estimated Annual Revenue",
      currentRaw: groups.revenue,
      changeRatioRaw: groups.revenue_change_percentage,
      thresholdRatio,
      asPercent: false,
    }),
  ];

  let result = {
    sourceName: "USDS",
    summaryTime: overall.date,
    baselineLabel: "t-1",
    ruleDescription: "相对 t-1",
    note: "数据源: overall/?days_ago=1 与 groups/overall/?days_ago=1",
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
