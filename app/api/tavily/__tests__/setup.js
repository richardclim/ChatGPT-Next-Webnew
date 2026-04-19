if (typeof Request === "undefined") {
  global.Headers = class Headers {
    constructor(init) {
      this._headers = new Map();
      if (init) {
        Object.entries(init).forEach(([k, v]) => this._headers.set(k.toLowerCase(), v));
      }
    }
    get(name) { return this._headers.get(name.toLowerCase()) || null; }
    set(name, value) { this._headers.set(name.toLowerCase(), value); }
    entries() { return this._headers.entries(); }
    [Symbol.iterator]() { return this._headers.entries(); }
  };


  global.Request = class Request {
    constructor(input, init) {
      this._url = input;
      this._method = init?.method || "GET";
      this._body = init?.body;
      this._json = init?.body ? JSON.parse(init.body) : null;
      this._headers = new Headers(init?.headers);
    }
    get url() { return this._url; }
    get method() { return this._method; }
    get headers() { return this._headers; }
    async json() { return this._json; }
  };

  global.Response = class Response {
    constructor(body, init) {
      this._body = body;
      this._status = init?.status || 200;
      this._headers = new Headers(init?.headers);
    }
    get status() { return this._status; }
    get headers() { return this._headers; }
    async json() { 
      return this._body ? JSON.parse(this._body) : null; 
    }
    static json(data, init) {
      return new Response(JSON.stringify(data), init);
    }
  };

  global.NextResponse = class NextResponse extends global.Response {
    static json(data, init) {
      return new NextResponse(JSON.stringify(data), init);
    }
  };
}



