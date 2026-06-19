#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.test.local");
const CASES_FILE = path.join(ROOT, "tests", "factor-cases.json");
const REPORT_DIR = path.join(ROOT, "reports");
const REPORT_JSON = path.join(REPORT_DIR, "factor-regression-report.json");
const REPORT_MD = path.join(REPORT_DIR, "factor-regression-report.md");
const REQUEST_TIMEOUT_MS = 20000;

const REQUIRED_ENV_KEYS = [
  "DIFY_API_BASE_URL",
  "DIFY_OLD_APP_KEY",
  "DIFY_FACTOR_TEST_APP_KEY",
];

function readAllowedEnv(filePath) {
  const values = {};
  const warnings = [];

  if (!fs.existsSync(filePath)) {
    warnings.push("Missing .env.test.local at project root.");
    return { values, warnings };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    if (!REQUIRED_ENV_KEYS.includes(key)) continue;

    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return { values, warnings };
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function joinDifyUrl(baseUrl, endpoint) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/v1")) return `${normalized}${endpoint}`;
  return `${normalized}/v1${endpoint}`;
}

function truncate(value, max = 900) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function maybeParseJsonString(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectStrings(value, state = { strings: [], factorStrings: [], hasFactorField: false }, pathParts = []) {
  if (value == null) return state;

  if (typeof value === "string") {
    state.strings.push(value);

    const pathText = pathParts.join(".").toLowerCase();
    if (/fact_?factors?|legal_?fact_?factor/.test(pathText)) {
      state.hasFactorField = true;
      state.factorStrings.push(value);
    }

    const parsed = maybeParseJsonString(value);
    if (parsed) collectStrings(parsed, state, pathParts.concat("parsed_json"));
    if (/"?(fact_factors?|legal_fact_factor)"?\s*[:=]/i.test(value)) {
      state.hasFactorField = true;
    }

    return state;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, state, pathParts.concat(String(index))));
    return state;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/fact_?factors?|legal_?fact_?factor/.test(key.toLowerCase())) {
        state.hasFactorField = true;
      }
      collectStrings(child, state, pathParts.concat(key));
    }
  }

  return state;
}

function evaluateClaims(output, testCase) {
  if (!output || output.skipped) {
    return {
      pass: false,
      missingExpected: testCase.expected_claims || [],
      forbiddenPresent: [],
      parse_error: Boolean(output && output.parse_error),
      skipped: Boolean(output && output.skipped),
    };
  }

  const haystack = (output._strings || []).join("\n");
  const missingExpected = (testCase.expected_claims || []).filter((claim) => !haystack.includes(claim));
  const forbiddenPresent = (testCase.forbidden_claims || []).filter((claim) => haystack.includes(claim));

  return {
    pass: missingExpected.length === 0 && forbiddenPresent.length === 0 && !output.parse_error,
    missingExpected,
    forbiddenPresent,
    parse_error: Boolean(output.parse_error),
    skipped: false,
  };
}

function evaluateFactors(output, testCase) {
  const expected = testCase.expected_legal_fact_factors || [];

  if (!output || output.skipped) {
    return {
      status: "skipped",
      missing: expected,
      missing_factor_output: false,
    };
  }

  if (output.parse_error) {
    return {
      status: "parse_error",
      missing: expected,
      missing_factor_output: false,
    };
  }

  const haystack = (output._strings || []).join("\n");
  const missing = expected.filter((factor) => !haystack.includes(factor));
  const missingFactorOutput = expected.length > 0 && !output._hasFactorField;

  return {
    status: missing.length === 0 && !missingFactorOutput ? "pass" : "fail",
    missing,
    missing_factor_output: missingFactorOutput,
  };
}

async function postJson(url, apiKey, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw_text: text };
  }

  return { ok: response.ok, status: response.status, body };
}

function buildDifyAttempts(baseUrl, input) {
  return [
    {
      kind: "chat-messages",
      url: joinDifyUrl(baseUrl, "/chat-messages"),
      payload: { inputs: {}, query: input, response_mode: "blocking", user: "factor-regression-test" },
    },
    {
      kind: "completion-messages",
      url: joinDifyUrl(baseUrl, "/completion-messages"),
      payload: { inputs: { query: input, input }, response_mode: "blocking", user: "factor-regression-test" },
    },
    {
      kind: "workflows-run",
      url: joinDifyUrl(baseUrl, "/workflows/run"),
      payload: { inputs: { query: input, input, text: input }, response_mode: "blocking", user: "factor-regression-test" },
    },
  ];
}

async function callAttempt(attempt, apiKey, appLabel) {
  const result = await postJson(attempt.url, apiKey, attempt.payload);
  if (!result.ok) {
    return {
      ok: false,
      error: { endpoint: attempt.kind, status: result.status, body: truncate(result.body, 300) },
    };
  }

  const collected = collectStrings(result.body);
  return {
    ok: true,
    output: {
      app: appLabel,
      endpoint: attempt.kind,
      raw: result.body,
      _strings: collected.strings,
      _factorStrings: collected.factorStrings,
      _hasFactorField: collected.hasFactorField,
    },
  };
}

async function callDifyApp({ baseUrl, apiKey, input, appLabel, preferredEndpoint }) {
  if (!baseUrl || !apiKey) {
    return { output: { skipped: true, reason: `Missing configuration for ${appLabel}.` }, endpoint: preferredEndpoint };
  }

  if (typeof fetch !== "function") {
    return {
      output: { parse_error: true, error: "Node.js fetch is unavailable. Use Node.js 18 or newer." },
      endpoint: preferredEndpoint,
    };
  }

  const attempts = buildDifyAttempts(baseUrl, input);
  const orderedAttempts = preferredEndpoint
    ? [
        ...attempts.filter((attempt) => attempt.kind === preferredEndpoint),
        ...attempts.filter((attempt) => attempt.kind !== preferredEndpoint),
      ]
    : attempts;

  const endpointErrors = [];

  for (const attempt of orderedAttempts) {
    try {
      const result = await callAttempt(attempt, apiKey, appLabel);
      if (result.ok) return { output: result.output, endpoint: attempt.kind };
      endpointErrors.push(result.error);
    } catch (error) {
      endpointErrors.push({ endpoint: attempt.kind, error: error.name === "AbortError" ? "request timeout" : error.message });
    }
  }

  return {
    output: {
      app: appLabel,
      parse_error: true,
      error: "All compatible Dify endpoints failed.",
      endpoint_errors: endpointErrors,
      _strings: [],
      _factorStrings: [],
      _hasFactorField: false,
    },
    endpoint: preferredEndpoint,
  };
}

function outputSummary(output) {
  if (!output) return "";
  if (output.skipped) return `Skipped: ${output.reason}`;
  if (output.parse_error) return truncate(output, 500);
  return truncate((output._strings || []).join(" | "), 700);
}

function failureReasons(claimEval, factorEval, isNew) {
  const reasons = [];
  if (claimEval.skipped) reasons.push("workflow skipped");
  if (claimEval.parse_error) reasons.push("parse_error");
  if (claimEval.missingExpected.length) reasons.push(`missing expected claims: ${claimEval.missingExpected.join(", ")}`);
  if (claimEval.forbiddenPresent.length) reasons.push(`forbidden claims present: ${claimEval.forbiddenPresent.join(", ")}`);
  if (isNew && factorEval.missing_factor_output) reasons.push("missing_factor_output");
  if (isNew && factorEval.missing.length) reasons.push(`missing fact factors: ${factorEval.missing.join(", ")}`);
  return reasons;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Factor Regression Report");
  lines.push("");
  lines.push("Generated by `scripts/run-factor-regression-test.js`. API keys are never printed in this report.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- total cases: ${report.summary.total_cases}`);
  lines.push(`- old passed count: ${report.summary.old_passed_count}`);
  lines.push(`- new passed count: ${report.summary.new_passed_count}`);
  lines.push(`- new better count: ${report.summary.new_better_count}`);
  lines.push(`- new worse count: ${report.summary.new_worse_count}`);
  lines.push(`- suspicious cases: ${report.summary.suspicious_cases.length ? report.summary.suspicious_cases.join(", ") : "none"}`);
  lines.push("");

  for (const item of report.cases) {
    lines.push(`## ${item.id}`);
    lines.push("");
    lines.push(`- input: ${item.input}`);
    lines.push(`- expected_claims: ${JSON.stringify(item.expected_claims)}`);
    lines.push(`- forbidden_claims: ${JSON.stringify(item.forbidden_claims)}`);
    lines.push(`- expected_legal_fact_factors: ${JSON.stringify(item.expected_legal_fact_factors)}`);
    lines.push(`- old_output summary: ${item.old_output_summary || "(empty)"}`);
    lines.push(`- new_output summary: ${item.new_output_summary || "(empty)"}`);
    lines.push(`- old_pass: ${item.old_pass}`);
    lines.push(`- new_pass: ${item.new_pass}`);
    lines.push(`- factor_check: ${item.factor_check.status}${item.factor_check.missing_factor_output ? " (missing_factor_output)" : ""}`);
    lines.push(`- new_better_than_old: ${item.new_better_than_old}`);
    lines.push(`- failure_reasons: ${item.failure_reasons.length ? item.failure_reasons.join("; ") : "none"}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values: env, warnings } = readAllowedEnv(ENV_FILE);
  const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key]);

  warnings.forEach((warning) => console.warn(warning));
  if (missing.includes("DIFY_API_BASE_URL")) console.warn("Missing DIFY_API_BASE_URL; Dify calls will be skipped.");
  if (missing.includes("DIFY_OLD_APP_KEY")) console.warn("Missing DIFY_OLD_APP_KEY; old workflow calls will be skipped.");
  if (missing.includes("DIFY_FACTOR_TEST_APP_KEY")) {
    console.warn("Missing DIFY_FACTOR_TEST_APP_KEY; new Factor Test workflow calls will be skipped.");
  }

  const cases = JSON.parse(fs.readFileSync(CASES_FILE, "utf8"));
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const results = [];
  const preferredEndpoints = { old: null, new: null };
  const disabledApps = { old: null, new: null };

  for (const testCase of cases) {
    console.log(`Running ${testCase.id}...`);

    const oldCall = disabledApps.old
      ? { output: { skipped: true, reason: disabledApps.old }, endpoint: preferredEndpoints.old }
      : env.DIFY_API_BASE_URL && env.DIFY_OLD_APP_KEY
      ? await callDifyApp({
          baseUrl: env.DIFY_API_BASE_URL,
          apiKey: env.DIFY_OLD_APP_KEY,
          input: testCase.input,
          appLabel: "old",
          preferredEndpoint: preferredEndpoints.old,
        })
      : { output: { skipped: true, reason: "Missing DIFY_API_BASE_URL or DIFY_OLD_APP_KEY." }, endpoint: preferredEndpoints.old };
    preferredEndpoints.old = oldCall.endpoint || preferredEndpoints.old;

    const newCall = disabledApps.new
      ? { output: { skipped: true, reason: disabledApps.new }, endpoint: preferredEndpoints.new }
      : env.DIFY_API_BASE_URL && env.DIFY_FACTOR_TEST_APP_KEY
      ? await callDifyApp({
          baseUrl: env.DIFY_API_BASE_URL,
          apiKey: env.DIFY_FACTOR_TEST_APP_KEY,
          input: testCase.input,
          appLabel: "new",
          preferredEndpoint: preferredEndpoints.new,
        })
      : { output: { skipped: true, reason: "Missing DIFY_API_BASE_URL or DIFY_FACTOR_TEST_APP_KEY." }, endpoint: preferredEndpoints.new };
    preferredEndpoints.new = newCall.endpoint || preferredEndpoints.new;

    const oldOutput = oldCall.output;
    const newOutput = newCall.output;

    if (!preferredEndpoints.old && oldOutput.parse_error) {
      disabledApps.old = "Old workflow unavailable after endpoint probing; skipped remaining cases.";
    }
    if (!preferredEndpoints.new && newOutput.parse_error) {
      disabledApps.new = "New Factor Test workflow unavailable after endpoint probing; skipped remaining cases.";
    }

    const oldEval = evaluateClaims(oldOutput, testCase);
    const newEval = evaluateClaims(newOutput, testCase);
    const factorEval = evaluateFactors(newOutput, testCase);
    const newBetter = newEval.pass && (!oldEval.pass || factorEval.status === "pass");
    const newWorse = oldEval.pass && !newEval.pass;
    const reasons = [
      ...failureReasons(oldEval, { missing: [], missing_factor_output: false }, false).map((reason) => `old: ${reason}`),
      ...failureReasons(newEval, factorEval, true).map((reason) => `new: ${reason}`),
    ];

    results.push({
      id: testCase.id,
      input: testCase.input,
      notes: testCase.notes,
      expected_claims: testCase.expected_claims || [],
      allowed_claims: testCase.allowed_claims || [],
      forbidden_claims: testCase.forbidden_claims || [],
      expected_legal_fact_factors: testCase.expected_legal_fact_factors || [],
      old_output: oldOutput.raw || oldOutput,
      new_output: newOutput.raw || newOutput,
      old_output_summary: outputSummary(oldOutput),
      new_output_summary: outputSummary(newOutput),
      old_pass: oldEval.pass,
      new_pass: newEval.pass,
      factor_check: factorEval,
      new_better_than_old: newBetter,
      new_worse_than_old: newWorse,
      failure_reasons: reasons,
    });
  }

  const summary = {
    total_cases: results.length,
    old_passed_count: results.filter((item) => item.old_pass).length,
    new_passed_count: results.filter((item) => item.new_pass).length,
    new_better_count: results.filter((item) => item.new_better_than_old).length,
    new_worse_count: results.filter((item) => item.new_worse_than_old).length,
    suspicious_cases: results
      .filter((item) => item.failure_reasons.length > 0 || item.factor_check.status !== "pass")
      .map((item) => item.id),
  };

  const report = {
    generated_at: new Date().toISOString(),
    env: {
      DIFY_API_BASE_URL: env.DIFY_API_BASE_URL ? "present" : "missing",
      DIFY_OLD_APP_KEY: env.DIFY_OLD_APP_KEY ? "present" : "missing",
      DIFY_FACTOR_TEST_APP_KEY: env.DIFY_FACTOR_TEST_APP_KEY ? "present" : "missing",
    },
    summary,
    cases: results,
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(REPORT_MD, renderMarkdown(report), "utf8");

  console.log(`Wrote ${path.relative(ROOT, REPORT_JSON)}`);
  console.log(`Wrote ${path.relative(ROOT, REPORT_MD)}`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
