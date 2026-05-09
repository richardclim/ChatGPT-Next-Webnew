---
description: Comprehensive guide for writing and running tests in this Next.js project. Covers the Jest configuration, the two categories of tests (client-side vs server-side API routes), the Web API polyfill problem for API route tests, and established patterns.
---

# Testing Guide — ChatGPT-Next-Webnew

## 1. Project Test Infrastructure

### Configuration Files

| File | Purpose |
| :--- | :--- |
| `jest.config.ts` | Main Jest config. Uses `next/jest` wrapper, `jsdom` environment, `@/` path alias, `moduleNameMapper` for ESM redirects |
| `jest.setup.ts` | Global setup (runs after env). Polyfills `TextEncoder`/`TextDecoder`, `Headers`/`Request`/`Response`. Mocks `global.fetch`, `idb-keyval`, `nanoid`, `lodash-es`, and `@/app/client/api` |
| `.babelrc` | Babel preset `next/babel` for transpilation |
| `test/__mocks__/lodash-es.js` | CJS shim for `lodash-es` (referenced by `moduleNameMapper` in `jest.config.ts`) |

### What `jest.setup.ts` Provides Globally

The setup file centralizes all environment bootstrapping. **You do NOT need to repeat these mocks in individual test files** (though doing so is harmless — Jest deduplicates):

| Mock / Polyfill | Why |
| :--- | :--- |
| `global.fetch` | No-op fetch returning `{ ok: true, status: 200 }` by default |
| `Headers`, `Request`, `Response` | Web API polyfills for API route tests (Category B) |
| `idb-keyval` | Prevents `ReferenceError: indexedDB is not defined` from Zustand persist middleware |
| `nanoid` | ESM → CJS shim. Returns `"mock-nanoid-id"` |
| `lodash-es` | ESM → CJS shim with `debounce` (pass-through + `.cancel`/`.flush` stubs) |
| `@/app/client/api` | Mocks `getClientApi` (returns `{ llm: { chat: jest.fn() } }`) and `ServiceProvider` enum |

### `jest.config.ts` Key Settings

```typescript
moduleNameMapper: {
  "^@/(.*)$": "<rootDir>/$1",                          // Path alias
  "^lodash-es$": "<rootDir>/test/__mocks__/lodash-es.js",   // ESM redirect
  "^lodash-es/(.*)$": "<rootDir>/test/__mocks__/lodash-es.js", // Deep import redirect
},
```

### Key Libraries

- **Jest**: Test runner and assertion library.
- **React Testing Library**: For DOM-based testing of components.
- **@testing-library/user-event**: Preferred library for simulating user interactions (more realistic than `fireEvent`).
- **fast-check**: Property-based testing library used for complex logic and data invariants.

### Run Commands

```bash
# Interactive watch mode
npx jest --watch
# Single test file
npx jest path/to/file.test.ts
# CI mode
npx jest --ci
# Clear cache (useful after config/mock changes)
npx jest --no-cache
```

---

## 2. Categories of Tests

You **MUST** identify which category a test falls into before writing it.

### Category A: Client-Side / Store Tests (Logic)
**Examples:** `app/store/__tests__/*.test.ts`, `app/utils/*.test.ts`
Tests Zustand stores, state updates, and utility functions.
**Pattern:** Standard `import` + `jest.mock()` + "Dependency Firewall".

### Category B: Next.js API Route Tests (⚠️ REQUIRES SPECIAL HANDLING)
**Examples:** `app/api/tavily/__tests__/route.test.ts`, `app/api/vector/__tests__/upsert-replace.test.ts`
Tests server-side handlers using `NextRequest`/`NextResponse`.
**Patterns:** Mock `next/server` and use `require()` instead of `import` for the route handler. Web API polyfills (`Headers`, `Request`, `Response`) are now provided globally by `jest.setup.ts`.

### Category C: UI & Component Tests
**Examples:** `app/components/*.test.tsx`
Tests React components and user interactions.
**Patterns:** Use `@testing-library/react` and `@testing-library/user-event`. Mock SCSS and deep store dependencies.

---

## 3. The Web API Polyfill Problem (Category B — Detailed)

### Root Cause
`next/server` depends on Web APIs (`Request`, `Response`, `Headers`) not native to Node.js/jsdom. Importing them directly causes `ReferenceError`.

### Solution (Global — Preferred)
Web API polyfills are now provided **globally** in `jest.setup.ts`. For most API route tests, you only need to:

```typescript
jest.mock("next/server", () => ({
  NextRequest: global.Request,
  NextResponse: { json: (data: any, init?: any) => global.Response.json(data, init) },
}));
const { POST } = require("../route");
```

### Solution (Per-Route `setup.js` — Legacy / Edge Cases)
If a route test needs polyfills that run *before* module loading (e.g., it imports side-effectful modules at the top level), create a co-located `setup.js` file and pass it via `--setupFiles`:

```bash
npx jest app/api/<route>/__tests__/route.test.ts --setupFiles ./app/api/<route>/__tests__/setup.js
```

---

## 4. Mocking & Dependency Firewalls

### ESM Module Blockers (Handled Globally)
The following are mocked **globally** in `jest.setup.ts`. You do **not** need to add these to individual test files:

- `nanoid` — Returns `"mock-nanoid-id"`
- `lodash-es` — Provides `debounce` pass-through
- `idb-keyval` — No-op async stubs for `get`, `set`, `del`, `clear`, `keys`, `createStore`
- `@/app/client/api` — `getClientApi` returns `{ llm: { chat: jest.fn() } }`

### Overriding Global Mocks Per-Test
To customize the globally-mocked `getClientApi` in a specific test:

```typescript
import { getClientApi } from "@/app/client/api";

beforeEach(() => {
  const mockChat = jest.fn();
  (getClientApi as jest.Mock).mockReturnValue({
    llm: { chat: mockChat }
  });
});
```

> **⚠️ IMPORTANT:** Use `jest.Mock` casting on the import — do NOT use `jest.spyOn()` for globally-mocked modules. `spyOn` will fail with `TypeError: Cannot redefine property` because the module is already fully replaced.

### SCSS Module Mocking
Always mock stylesheet imports in component tests:
```typescript
jest.mock("./component.module.scss", () => ({
  "class-name": "class-name-mock",
}));
```

### The "Store Firewall" (Shallow)
To avoid deep dependency chains crashing Jest, mock the entire store if you only need a slice:
```typescript
jest.mock("@/app/store", () => ({
  useAccessStore: { getState: () => ({ enabled: true }) },
  useAppConfig: { getState: () => ({ modelConfig: {} }) },
}));
```

### The `createPersistStore` Bypass (Deep — Category A Store Tests)
When testing stores that use `createPersistStore` (e.g., `memory.ts`, `config.ts`), the Zustand persist middleware will attempt to hydrate from `indexedDB`, which doesn't exist in jsdom. While `idb-keyval` is now mocked globally (preventing crashes), tests that need to **control and inspect store state** should bypass persistence entirely:

```typescript
jest.mock("@/app/utils/store", () => ({
  createPersistStore: jest.fn((initialState: any, creator: any) => {
    const set = jest.fn((updater: any) => {
      if (typeof updater === 'function') {
        const nextState = { ...initialState };
        updater(nextState);
        Object.assign(initialState, nextState);
      } else {
        Object.assign(initialState, updater);
      }
    });
    const get = () => ({ ...initialState, ...methods });
    const methods = creator(set, get);
    return () => ({ ...initialState, ...methods });
  })
}));
```

**Reference:** `app/store/__tests__/profile-hybrid.test.ts`

### ⚠️ Stale State Pitfall
After async store operations (e.g., `processExtraction`), the local `store` variable may be **stale** because `createPersistStore` replaces state internally. Always re-fetch state for assertions:

```typescript
// ❌ WRONG — stale reference
await store.processExtraction(messages, "session-1");
expect(store.content.coding.languages).toContain("Go");

// ✅ CORRECT — fresh state
await store.processExtraction(messages, "session-1");
expect(useMemoryStore.getState().content.coding.languages).toContain("Go");
```

### `process.env` Isolation
Tests that mutate `process.env` **MUST** save and restore it to prevent leakage:

```typescript
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});
```

---

## 5. Property-Based Testing (fast-check)

For complex logic (e.g., parsing, string manipulation, data transformations), use `fast-check` to cover edge cases automatically. It is a **core requirement** for business logic tests.

```typescript
import * as fc from "fast-check";

it("should always satisfy [Property X]", () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      const result = someUtilityBytes(input);
      expect(result).toBeDefined();
    })
  );
});
```

---

## 6. PROTOCOL: Test Suite Generation Strategy

When tasked with writing tests, the AI **MUST** follow this protocol to ensure bulletproof coverage:

### Step 1: Component & Context Identification
- Determine if the feature is a **Hook/Store** (Category A), **API Route** (Category B), or **UI Component** (Category C).
- Identify external dependencies (LLM calls, database, stores) needing mocks.

### Step 2: Strategy Design
- **Unit Tests**: Isolated utilities and hooks.
- **Integration Tests**: Interacting with Server Actions, API routes, or Context providers.
- **Property-based Tests**: Use `fast-check` for any data-transformation logic.

### Step 3: Edge Case Enumeration (MANDATORY COVERAGE)
- **Empty States**: Zero results, empty arrays, null/undefined inputs.
- **Boundary Values**: Max lengths, 0 values, extreme dates.
- **Error States**: Throwing/mocking rejected promises for every external call.
- **Race Conditions**: Concurrent UI updates or rapid-fire events.

### Step 4: Next.js Specifics
- Mock `next/navigation` (router), `next/headers` (cookies/headers), and `next/cache`.
- Test **Suspense** boundaries and **ErrorBoundary** (`error.tsx`) triggers.

### Step 5: Implementation Rules
- **Interaction**: Use `@testing-library/user-event` (v14+) over `fireEvent`. `user-event` simulates full browser behavior.
- **Accessibility (a11y)**: Use ARIA-first queries (`getByRole`, `getByLabelText`, `getByPlaceholderText`) before falling back to `data-testid`.
- **Async Handling**: Use `waitFor` or `findBy*` queries for elements appearing after state changes.

### Step 6: Loop & Validate
- Run the test file using the appropriate category command.
- Fix until 100% pass.
- **REGRESSION CHECK**: Run `npx jest` (full suite) before finishing.

---

## 7. Checklist Before Finishing

- [ ] Category identified? (A, B, or C)
- [ ] API Route? (next/server mocked? `require()` used for handler?)
- [ ] Zustand persist store? (`createPersistStore` bypass used if needed?)
- [ ] `getClientApi` overridden correctly? (`jest.Mock` cast, NOT `spyOn`)
- [ ] `process.env` mutations isolated? (save/restore in beforeEach/afterEach)
- [ ] Assertions use fresh state? (`useStore.getState()` after async ops)
- [ ] Business logic uses `fast-check`?
- [ ] UI interactions use `user-event`?
- [ ] Accessibility roles used for queries?
- [ ] `clearAllMocks` in `beforeEach`?
- [ ] Full suite passes? (`npx jest`)
