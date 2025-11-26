import "dotenv/config";
import express from "express";
import { TAGGING_PROMPT } from "./prompts.config.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- Environment config ----------------------------------------------------

const {
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_VERSION = "2024-08-01-preview",
  AZURE_OPENAI_API_DEPLOYMENT_NAME = "gpt-5-chat",
  PORT = 3000,
} = process.env;

// ---- Helpers ---------------------------------------------------------------

function buildPromptFromInput(input) {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function interpolateTemplate(template, variables) {
  if (typeof template !== "string") return "";
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : ""
  );
}

function calculateCostInTHB(inputTokens, outputTokens, modelName) {
  const USD_TO_THB = 35;
  let inputPricePer1M = 0;
  let outputPricePer1M = 0;
  const model = (modelName || "").toLowerCase();

  if (model.includes("gpt-4o")) {
    inputPricePer1M = 2.5;
    outputPricePer1M = 10.0;
  } else if (model.includes("gpt-4-turbo") || model.includes("gpt-4-32k")) {
    inputPricePer1M = 10.0;
    outputPricePer1M = 30.0;
  } else if (model.includes("gpt-4")) {
    inputPricePer1M = 30.0;
    outputPricePer1M = 60.0;
  } else if (
    model.includes("gpt-35-turbo") ||
    model.includes("gpt-3.5-turbo")
  ) {
    inputPricePer1M = 0.5;
    outputPricePer1M = 1.5;
  } else {
    // default (เช่น snapshot ใหม่ ๆ)
    inputPricePer1M = 2.5;
    outputPricePer1M = 10.0;
  }

  const inputCostUSD = (inputTokens / 1_000_000) * inputPricePer1M;
  const outputCostUSD = (outputTokens / 1_000_000) * outputPricePer1M;
  const totalCostUSD = inputCostUSD + outputCostUSD;
  const totalCostTHB = totalCostUSD * USD_TO_THB;

  return {
    costUSD: parseFloat(totalCostUSD.toFixed(6)),
    costTHB: parseFloat(totalCostTHB.toFixed(4)),
    breakdown: {
      inputTokens,
      outputTokens,
      inputCostUSD: parseFloat(inputCostUSD.toFixed(6)),
      outputCostUSD: parseFloat(outputCostUSD.toFixed(6)),
      inputCostTHB: parseFloat((inputCostUSD * USD_TO_THB).toFixed(4)),
      outputCostTHB: parseFloat((outputCostUSD * USD_TO_THB).toFixed(4)),
      exchangeRate: USD_TO_THB,
      modelPricing: {
        inputPricePer1M,
        outputPricePer1M,
        currency: "USD",
      },
    },
  };
}

// ---- Azure OpenAI call -----------------------------------------------------

async function callAzureChatCompletion({
  systemMessage,
  userMessage,
  temperature,
  maxTokens,
  schema,
}) {
  if (typeof fetch !== "function") {
    throw new Error(
      "Global fetch is not available in this environment. Please upgrade Node.js to v18+ or provide a fetch polyfill."
    );
  }

  if (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_ENDPOINT) {
    const err = new Error(
      "Missing Azure OpenAI credentials. Please set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT."
    );
    err.status = 500;
    throw err;
  }

  let completionUrl;
  try {
    const base = new URL(AZURE_OPENAI_ENDPOINT);
    completionUrl = new URL(
      `/openai/deployments/${AZURE_OPENAI_API_DEPLOYMENT_NAME}/chat/completions`,
      base
    );
    completionUrl.searchParams.set("api-version", AZURE_OPENAI_API_VERSION);
  } catch (err) {
    const error = new Error(`Invalid AZURE_OPENAI_ENDPOINT: ${err.message}`);
    error.status = 500;
    throw error;
  }

  const payload = {
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ],
    response_format: {
      type: "json_schema",
      json_schema: schema,
    },
  };

  const response = await fetch(completionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": AZURE_OPENAI_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  let data;
  try {
    data = await response.json();
  } catch (err) {
    const text = await response.text();
    const error = new Error(
      `Azure OpenAI returned a non-JSON response: ${text || err.message}`
    );
    error.status = response.status || 500;
    throw error;
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.error?.innererror?.message ||
      JSON.stringify(data);
    const error = new Error(
      `Azure OpenAI error (${response.status}): ${message}`
    );
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

// ---- Route: /api/tags ------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Tag Generation API is running.");
});
app.post("/api/tags", async (req, res) => {
  try {
    const body = req.body || {};
    const userInput = body.input;

    if (!userInput) {
      return res.status(400).json({ error: "Missing 'input' in request body" });
    }

    const simplePrompt = body.prompt;
    const customPrompt = body.customPrompt || {};

    const systemMessage =
      simplePrompt ||
      customPrompt.systemMessage ||
      TAGGING_PROMPT.systemMessage;

    const userTemplate =
      customPrompt.userTemplate || TAGGING_PROMPT.userTemplate;

    const temperature =
      customPrompt.temperature ?? TAGGING_PROMPT.temperature ?? 0;

    const maxTokens = customPrompt.maxTokens ?? TAGGING_PROMPT.maxTokens ?? 512;

    const schema = customPrompt.schema || TAGGING_PROMPT.schema;

    if (!schema) {
      return res.status(500).json({
        error: "Missing JSON schema configuration for tagging.",
      });
    }

    const contentForPrompt = buildPromptFromInput(userInput);
    const userMessage = interpolateTemplate(userTemplate, {
      json_input: contentForPrompt,
    });

    const azureResponse = await callAzureChatCompletion({
      systemMessage,
      userMessage,
      temperature,
      maxTokens,
      schema,
    });

    const choice = azureResponse?.choices?.[0];
    const message = choice?.message;

    if (!message) {
      throw new Error("Azure OpenAI returned no choices/message.");
    }

    let rawContent = message.content;

    // รองรับทั้งกรณี content เป็น string หรือ array ของ content parts
    if (Array.isArray(rawContent)) {
      const jsonPart =
        rawContent.find((p) => p.type === "output_json") ||
        rawContent.find((p) => p.type === "text");

      if (jsonPart) {
        rawContent = jsonPart.output_json || jsonPart.text;
      }
    }

    if (typeof rawContent !== "string" || !rawContent.trim()) {
      throw new Error(
        "Azure OpenAI returned an empty or unsupported message content."
      );
    }

    let aiOutput;
    try {
      aiOutput = JSON.parse(rawContent);
    } catch (err) {
      throw new Error(`Unable to parse AI response as JSON: ${err.message}`);
    }

    const usage = azureResponse?.usage || null;
    let pricing = null;

    const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
    const outputTokens =
      usage?.completion_tokens ?? usage?.output_tokens ?? null;

    if (typeof inputTokens === "number" && typeof outputTokens === "number") {
      pricing = calculateCostInTHB(
        inputTokens,
        outputTokens,
        AZURE_OPENAI_API_DEPLOYMENT_NAME
      );
    }

    return res.json({
      ...aiOutput,
      usage,
      pricing,
    });
  } catch (error) {
    console.error("Tag API error:", error);
    const status = error.status || error?.response?.status || 500;
    return res.status(status).json({
      error: error.message || "Internal Server Error",
      details: error.details || undefined,
    });
  }
});

// ---- Start server ----------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Tag generation API is running on http://localhost:${PORT}`);
});

export default app;
