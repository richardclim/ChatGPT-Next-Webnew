import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const QUEUE_FILE = path.join(process.cwd(), "external-chat-queue.json");

type RequestStatus = "pending" | "processing" | "completed";

interface QueueData {
  request?: {
    id: string;
    content: string;
    model?: string;
    timestamp?: number;
    status: RequestStatus;
    isNewChat?: boolean;
  };
  response?: {
    id: string;
    content: string;
    timestamp: number;
    title?: string;
  };
}

function getQueue(): QueueData {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Error reading queue file:", e);
  }
  return {};
}

function saveQueue(data: QueueData) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Error writing queue file:", e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, ...data } = body;

    const queue = getQueue();

    if (action === "queue") {
      queue.request = {
        id: data.id,
        content: data.content,
        model: data.model,
        timestamp: Date.now(),
        status: "pending",
        isNewChat: data.isNewChat,
      };
      delete queue.response;
      saveQueue(queue);
      return NextResponse.json({ success: true, message: "Request queued" });
    } else if (action === "acknowledge") {
      // Tampermonkey acknowledges it's processing the request
      if (queue.request && queue.request.id === data.id) {
        queue.request.status = "processing";
        saveQueue(queue);
        return NextResponse.json({
          success: true,
          message: "Request acknowledged",
        });
      }
      return NextResponse.json({
        success: false,
        message: "Request not found or ID mismatch",
      });
    } else if (action === "response") {
      // Tampermonkey sends the response back
      queue.response = {
        id: data.id,
        content: data.content,
        timestamp: Date.now(),
        ...(data.title && { title: data.title }),
      };
      // Clear the request - processing complete
      delete queue.request;
      saveQueue(queue);
      return NextResponse.json({ success: true, message: "Response received" });
    } else if (action === "poll_response") {
      // Client polls for the response
      if (queue.response) {
        const response = queue.response;
        return NextResponse.json({ success: true, response });
      } else {
        return NextResponse.json({
          success: false,
          message: "No response yet",
        });
      }
    }

    return NextResponse.json(
      { success: false, message: "Invalid action" },
      { status: 400 },
    );
  } catch (e) {
    console.error("Error in external-chat route:", e);
    return NextResponse.json(
      { success: false, message: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function GET() {
  const queue = getQueue();
  if (queue.request) {
    return NextResponse.json({ success: true, request: queue.request });
  }
  return NextResponse.json({ success: false, message: "No requests" });
}
