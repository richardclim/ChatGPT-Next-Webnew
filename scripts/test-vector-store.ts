/**
 * Manual test script for the vector store.
 *
 * Prerequisites:
 *   1. GOOGLE_API_KEY must be set in .env.local (used for embeddings)
 *   2. Dev server must be running: yarn dev
 *   3. Create scripts/.env.test with your access code (see below)
 *
 * Setup:
 *   Create scripts/.env.test with:
 *     CODE=your-access-code-here
 *     BASE_URL=http://localhost:3000
 *
 * Usage:
 *   npx tsx scripts/test-vector-store.ts
 */

import * as fs from "fs";
import * as pathMod from "path";

// Load env vars from scripts/.env.test if it exists
const envPath = pathMod.join(__dirname, ".env.test");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ACCESS_CODE = process.env.CODE || "";

function authHeader(): Record<string, string> {
  if (ACCESS_CODE) {
    return { Authorization: `Bearer nk-${ACCESS_CODE}` };
  }
  return {};
}

// ── Sample data ──────────────────────────────────────────────────────
const TEST_SESSION_ID = "test-session-001";

const sampleChunks = [
  {
    id: "test-vec-1",
    content:
      "Summary: The user prefers dark mode in all applications and uses VS Code as their primary editor.\nKeywords: dark mode, VS Code, preferences, editor",
    sessionId: TEST_SESSION_ID,
    createdAt: Date.now(),
    keywords: ["dark mode", "VS Code", "preferences", "editor"],
  },
  {
    id: "test-vec-2",
    content:
      "Summary: The user is building a Next.js chat application with multiple LLM provider support.\nKeywords: Next.js, chat, LLM, multi-provider",
    sessionId: TEST_SESSION_ID,
    createdAt: Date.now() - 60_000,
    keywords: ["Next.js", "chat", "LLM", "multi-provider"],
  },
  {
    id: "test-vec-3",
    content:
      "Summary: The user asked about vector databases and chose LanceDB for its embedded nature and simplicity.\nKeywords: vector database, LanceDB, embedded, RAG",
    sessionId: TEST_SESSION_ID,
    createdAt: Date.now() - 120_000,
    keywords: ["vector database", "LanceDB", "embedded", "RAG"],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

async function preflight() {
  console.log("\n[PREFLIGHT] Checking connectivity and auth...\n");

  // 1. Can we reach the server at all?
  try {
    const res = await fetch(`${BASE_URL}/api/config`);
    if (!res.ok) {
      console.log(`  Server returned ${res.status} on /api/config`);
    } else {
      console.log("  Server is reachable.");
    }
  } catch (err) {
    console.error(
      `  Cannot reach ${BASE_URL}. Is the dev server running (yarn dev)?`,
    );
    throw err;
  }

  // 2. Does the debug endpoint work? (no embeddings needed, tests auth + LanceDB)
  const debugRes = await fetch(`${BASE_URL}/api/vector/debug?limit=1`, {
    headers: authHeader(),
  });
  const debugBody = await debugRes.json();
  console.log(`  Debug endpoint: ${debugRes.status} - ${debugBody.status}`);
  if (debugBody.status === "error") {
    console.log(`  Debug error: ${debugBody.message}`);
  }
  if (debugRes.status === 401) {
    console.error(
      "  AUTH FAILED. Check your CODE in scripts/.env.test matches your .env.local CODE.",
    );
    throw new Error("Authentication failed");
  }

  console.log("  Auth OK.\n");
}

async function upsert() {
  console.log("[INSERT] Inserting test chunks into vector store...\n");

  const res = await fetch(`${BASE_URL}/api/vector/upsert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
    body: JSON.stringify({
      chunks: sampleChunks,
      // No provider/model -> skips the LLM dedup callback, always inserts
    }),
  });

  let body: any;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = { rawResponse: text };
  }

  console.log(`  Status: ${res.status}`);
  console.log(`  Response:`, JSON.stringify(body, null, 2));

  if (!res.ok) {
    console.log(
      "\n  HINT: A 500 here usually means GOOGLE_API_KEY is missing or invalid",
    );
    console.log(
      "  in your .env.local. The embeddings require a valid Google API key.",
    );
    console.log("  Check your dev server terminal for the actual error.\n");
    throw new Error(`Upsert failed: ${res.status}`);
  }
  console.log("\n[OK] Upsert succeeded.\n");
}

async function debugList() {
  console.log("[LIST] Fetching records from debug endpoint...\n");

  const res = await fetch(`${BASE_URL}/api/vector/debug?limit=10`, {
    headers: authHeader(),
  });

  const body = await res.json();
  console.log(`  Status: ${res.status}`);
  console.log(`  Total records: ${body.stats?.totalRecords ?? "N/A"}`);
  console.log(`  Filtered count: ${body.stats?.filteredCount ?? "N/A"}`);

  if (body.records) {
    console.log(`\n  Records (${body.records.length}):`);
    for (const rec of body.records) {
      console.log(`    [${rec.id}] ${rec.contentPreview}`);
      console.log(
        `      session=${rec.sessionId}  dims=${rec.vectorDimensions}  date=${rec.createdAtFormatted}`,
      );
    }
  }
  console.log();
}

async function searchTest(query: string) {
  console.log(`[SEARCH] Searching for: "${query}"\n`);

  const res = await fetch(`${BASE_URL}/api/vector/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
    body: JSON.stringify({ query, limit: 5 }),
  });

  const body = await res.json();
  console.log(`  Status: ${res.status}`);

  if (body.results) {
    console.log(`  Results (${body.results.length}):`);
    for (const r of body.results) {
      const similarity =
        r._relevance_score != null
          ? `rel=${r._relevance_score.toFixed(4)}`
          : r._distance != null
          ? `sim=${(1 - r._distance).toFixed(4)}`
          : "N/A";
      const preview =
        r.content?.length > 100
          ? r.content.substring(0, 100) + "..."
          : r.content;
      console.log(`    [${similarity}] ${preview}`);
    }
  } else {
    console.log(`  Response:`, JSON.stringify(body, null, 2));
  }
  console.log();
}

async function cleanup() {
  console.log("[CLEANUP] Cleaning up test records...\n");

  for (const chunk of sampleChunks) {
    const res = await fetch(
      `${BASE_URL}/api/vector/debug?id=${encodeURIComponent(chunk.id)}`,
      {
        method: "DELETE",
        headers: authHeader(),
      },
    );
    const body = await res.json();
    console.log(`  Delete ${chunk.id}: ${body.status} - ${body.message}`);
  }
  console.log("\n[OK] Cleanup done.\n");
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "all";

  console.log("===========================================");
  console.log("  Vector Store Manual Test");
  console.log(`  Target: ${BASE_URL}`);
  console.log("===========================================");

  try {
    // Always run preflight first
    await preflight();

    switch (command) {
      case "insert":
        await upsert();
        break;
      case "list":
        await debugList();
        break;
      case "search":
        await searchTest(args[1] || "dark mode editor");
        break;
      case "cleanup":
        await cleanup();
        break;
      case "all":
      default:
        await upsert();
        await debugList();
        await searchTest("dark mode editor");
        await searchTest("vector database");
        await cleanup();
        await debugList();
        break;
    }
  } catch (err) {
    console.error("\n[ERROR]", err);
    process.exit(1);
  }
}

main();
