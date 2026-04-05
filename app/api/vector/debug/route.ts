import { NextResponse } from "next/server";
import * as lancedb from "@lancedb/lancedb";
import path from "path";
import fs from "fs";

import { stripKeywordsLine } from "../store";

const DB_PATH = path.join(process.cwd(), "nextchat-data", "vectors");
const TABLE_NAME = "episodic_memory";

/**
 * Type definition for records stored in LanceDB
 * This provides type safety instead of using 'any'
 */
interface LanceDBRecord {
  id: string;
  content: string;
  /** New schema: array of contributing session IDs */
  sessionIds?: string[];
  /** Legacy schema: single session ID string */
  sessionId?: string;
  createdAt: number;
  keywords?: string[];
  vector?: number[];
  _distance?: number; // Added by LanceDB during search operations
}



/**
 * Transformed record for API response (without vector data)
 */
interface TransformedRecord {
  _index: number;
  id: string;
  content: string;
  sessionIds: string[];
  createdAt: number;
  keywords?: string[];
  createdAtFormatted: string | null;
  vectorDimensions: number;
  contentPreview: string;
}

/**
 * Debug endpoint for viewing LanceDB vector store contents.
 *
 * Query Parameters:
 * - limit: Number of records per page (default: 20, max: 100)
 * - offset: Starting record index for pagination (default: 0)
 * - search: Text to search for in content (optional)
 * - sessionId: Filter by specific sessionId (optional)
 */
export async function GET(request: Request) {
  try {
    // Check if database directory exists
    if (!fs.existsSync(DB_PATH)) {
      return NextResponse.json({
        status: "empty",
        message: "Database directory does not exist yet.",
        dbPath: DB_PATH,
      });
    }

    const db = await lancedb.connect(DB_PATH);
    const tableNames = await db.tableNames();

    if (!tableNames.includes(TABLE_NAME)) {
      return NextResponse.json({
        status: "empty",
        message: `Table '${TABLE_NAME}' does not exist yet.`,
        availableTables: tableNames,
        dbPath: DB_PATH,
      });
    }

    const table = await db.openTable(TABLE_NAME);

    // Parse URL parameters
    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") || "20"), 1),
      100,
    );
    const offset = Math.max(parseInt(searchParams.get("offset") || "0"), 0);
    const searchQuery = searchParams.get("search") || "";
    const sessionIdFilter = searchParams.get("sessionId") || "";

    // Get total count first (unfiltered)
    const totalRecords = await table.countRows();

    // Columns to select explicitly to exclude massive Vector embedding data
    // We dynamically verify these columns exist in the DB schema via a 1-row probe
    // This flawlessly handles older legacy local databases that lack the new "sessionIds" column
    let selectColumns = [
      "id",
      "content",
      "createdAt",
      "sessionId",
      "sessionIds",
      "keywords",
    ];

    let schemaDimensions = 0;
    if (totalRecords > 0) {
      try {
        const sampleRow = await table.query().limit(1).toArray();
        if (sampleRow.length > 0) {
          const actualDbColumns = Object.keys(sampleRow[0]);
          selectColumns = selectColumns.filter((col) =>
            actualDbColumns.includes(col),
          );

          // Extract array length for displaying dimensions dynamically
          const sampleVector = sampleRow[0].vector;
          if (sampleVector && typeof sampleVector.length === "number") {
            schemaDimensions = sampleVector.length;
          }
        }
      } catch (schemaError) {
        console.warn(
          "[Vector Debug] Could not probe dynamic schema",
          schemaError,
        );
      }
    }

    let allRecords: LanceDBRecord[] = [];

    if (searchQuery) {
      // Use SQL LIKE for exact partial string matching instead of token-based FTS (fixes "assist" vs "assistant")
      // Do not use limit(), pulling everything matching to avoid 1000 limit truncation
      // Select only the metadata (excluding the vector) to drastically save memory
      const safeSearchQuery = searchQuery.replace(/'/g, "''");
      allRecords = (await table
        .query()
        .where(`content LIKE '%${safeSearchQuery}%'`)
        .select(selectColumns)
        .toArray()) as LanceDBRecord[];
    } else {
      // No search - just query all, without limit and without vectors
      allRecords = (await table
        .query()
        .select(selectColumns)
        .toArray()) as LanceDBRecord[];
    }

    // Apply sessionId filter if provided
    if (sessionIdFilter) {
      allRecords = allRecords.filter((record) =>
        (Array.from(record.sessionIds || []) as string[]).includes(sessionIdFilter),
      );
    }

    // Sort by createdAt descending (newest first)
    allRecords.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // Count after filtering
    const filteredCount = allRecords.length;

    // Apply pagination (offset + limit)
    const paginatedRecords = allRecords.slice(offset, offset + limit);

    // Transform records for response (strip vector, add metadata)
    const records: TransformedRecord[] = paginatedRecords.map(
      (record, index) => {
        const { vector, ...rest } = record;
        const cleanContent = stripKeywordsLine(record.content || "");
        return {
          _index: offset + index, // Absolute index in the filtered set
          ...rest,
          content: cleanContent,
          sessionIds: (record.sessionIds ? Array.from(record.sessionIds) : []) as string[],
          // Format createdAt as human-readable date
          createdAtFormatted: record.createdAt
            ? new Date(record.createdAt).toLocaleString()
            : null,
          vectorDimensions: schemaDimensions,
          // Truncate content preview for list view
          contentPreview:
            cleanContent.length > 200
              ? cleanContent.substring(0, 200) + "..."
              : cleanContent,
        };
      },
    );

    // Get unique sessionIds across all records (flatten arrays, dedup)
    const uniqueSessionIds = [
      ...new Set(
        allRecords.flatMap((r) => r.sessionIds ? Array.from(r.sessionIds) : []).filter(Boolean),
      ),
    ].slice(0, 50); // Limit to 50 sessions

    // Calculate pagination info
    const hasNextPage = offset + limit < filteredCount;
    const hasPrevPage = offset > 0;
    const currentPage = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(filteredCount / limit);

    return NextResponse.json({
      status: "success",
      tableName: TABLE_NAME,
      dbPath: DB_PATH,

      // Stats
      stats: {
        totalRecords,
        filteredCount,
        showingFrom: offset + 1,
        showingTo: Math.min(offset + limit, filteredCount),
      },

      // Pagination
      pagination: {
        limit,
        offset,
        currentPage,
        totalPages,
        hasNextPage,
        hasPrevPage,
        nextOffset: hasNextPage ? offset + limit : null,
        prevOffset: hasPrevPage ? Math.max(0, offset - limit) : null,
      },

      // Filters applied
      filters: {
        search: searchQuery || null,
        sessionId: sessionIdFilter || null,
      },

      // Available filter options
      availableFilters: {
        sessionIds: uniqueSessionIds,
      },

      // The actual records
      records,
    });
  } catch (error) {
    console.error("[Vector Debug] Error:", error);
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown error",
        stack:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.stack
            : undefined,
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE endpoint for removing a record by ID.
 *
 * Query Parameters:
 * - id: The ID of the record to delete (required)
 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const recordId = searchParams.get("id");

    if (!recordId) {
      return NextResponse.json(
        {
          status: "error",
          message: "Missing required parameter: id",
        },
        { status: 400 },
      );
    }

    // Check if database exists
    if (!fs.existsSync(DB_PATH)) {
      return NextResponse.json(
        {
          status: "error",
          message: "Database does not exist",
        },
        { status: 404 },
      );
    }

    const db = await lancedb.connect(DB_PATH);
    const tableNames = await db.tableNames();

    if (!tableNames.includes(TABLE_NAME)) {
      return NextResponse.json(
        {
          status: "error",
          message: `Table '${TABLE_NAME}' does not exist`,
        },
        { status: 404 },
      );
    }

    const table = await db.openTable(TABLE_NAME);

    // Check if record exists before deleting
    const existingRecords = (await table
      .query()
      .where(`id = '${recordId.replace(/'/g, "''")}'`) // Escape single quotes
      .limit(1)
      .toArray()) as LanceDBRecord[];

    if (existingRecords.length === 0) {
      return NextResponse.json(
        {
          status: "error",
          message: `Record with id '${recordId}' not found`,
        },
        { status: 404 },
      );
    }

    // Delete the record - escape single quotes in the ID
    const escapedId = recordId.replace(/'/g, "''");
    await table.delete(`id = '${escapedId}'`);

    console.log(`[Vector Debug] Deleted record: ${recordId}`);

    return NextResponse.json({
      status: "success",
      message: `Record '${recordId}' deleted successfully`,
      deletedId: recordId,
    });
  } catch (error) {
    console.error("[Vector Debug] Delete error:", error);
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
