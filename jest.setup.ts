// Learn more: https://github.com/testing-library/jest-dom
import "@testing-library/jest-dom";
import { jest } from "@jest/globals";
import { TextDecoder, TextEncoder } from "util";

global.TextDecoder = TextDecoder as any;
global.TextEncoder = TextEncoder as any;

global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve([]),
    headers: new Headers(),
    redirected: false,
    statusText: "OK",
    type: "basic",
    url: "",
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(""),
  } as Response),
);

// Polyfill Web APIs for Next.js API route tests (Category B)
if (typeof Headers === "undefined") {
  global.Headers = class Headers {
    private _h = new Map<string, string>();
    constructor(init?: any) {
      if (init) Object.entries(init).forEach(([k, v]) => this._h.set(k.toLowerCase(), v as string));
    }
    get(n: string) { return this._h.get(n.toLowerCase()) || null; }
    set(n: string, v: string) { this._h.set(n.toLowerCase(), v); }
    has(n: string) { return this._h.has(n.toLowerCase()); }
    forEach(cb: any) { this._h.forEach((v, k) => cb(v, k)); }
  } as any;
}

if (typeof Request === "undefined") {
  global.Request = class Request {
    public url: string;
    public method: string;
    public headers: Headers;
    private _body: any;
    constructor(input: any, init?: any) {
      this.url = input;
      this.method = init?.method || "GET";
      this.headers = new Headers(init?.headers);
      this._body = init?.body;
    }
    async json() { return JSON.parse(this._body); }
    async text() { return this._body; }
  } as any;
}

if (typeof Response === "undefined") {
  global.Response = class Response {
    public status: number;
    public headers: Headers;
    private _body: any;
    constructor(body?: any, init?: any) {
      this._body = body;
      this.status = init?.status || 200;
      this.headers = new Headers(init?.headers);
    }
    async json() { return JSON.parse(this._body); }
    async text() { return this._body; }
    static json(data: any, init?: any) {
      return new Response(JSON.stringify(data), {
        ...init,
        headers: { ...init?.headers, "content-type": "application/json" }
      });
    }
  } as any;
}

// Global mocks for common ESM libraries that cause Jest issues
jest.mock("idb-keyval", () => ({
  get: jest.fn(() => Promise.resolve(null)),
  set: jest.fn(() => Promise.resolve()),
  del: jest.fn(() => Promise.resolve()),
  clear: jest.fn(() => Promise.resolve()),
  keys: jest.fn(() => Promise.resolve([])),
  createStore: jest.fn(() => ({})),
}));

jest.mock("nanoid", () => ({
  nanoid: () => "mock-nanoid-id",
}));

jest.mock("lodash-es", () => ({
  // Add common lodash functions used in the project if needed
  debounce: (fn: any) => {
    fn.cancel = () => {};
    fn.flush = () => {};
    return fn;
  },
}));

jest.mock("@/app/client/api", () => ({
  getClientApi: jest.fn(() => ({
    llm: { chat: jest.fn() }
  })),
  ServiceProvider: {
    OpenAI: "OpenAI",
    Azure: "Azure",
    Google: "Google",
    Anthropic: "Anthropic",
    Baidu: "Baidu",
    ByteDance: "ByteDance",
    Alibaba: "Alibaba",
    Tencent: "Tencent",
    Moonshot: "Moonshot",
    Stability: "Stability",
    Iflytek: "Iflytek",
    XAI: "XAI",
    ChatGLM: "ChatGLM",
    DeepSeek: "DeepSeek",
    SiliconFlow: "SiliconFlow",
    "302.AI": "302.AI",
  },
}));

