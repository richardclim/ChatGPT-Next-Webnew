## 2024-05-15 - [XSS Fix in Plugin Viewer]
**Vulnerability:** XSS vulnerability in `app/components/plugin.tsx` due to rendering user-controlled plugin `content` via `dangerouslySetInnerHTML` directly without escaping.
**Learning:** `DOMPurify` should be avoided for code snippet viewers (such as OpenAPI JSON/YAML plugins) because it can mistakenly strip valid syntactic elements containing `<` and `>`, leading to data corruption and breaking the editor functionality. Explicitly converting characters (`<`, `>`, `&`, `"`, `'`) with an `escapeHtml` utility works better.
**Prevention:** Whenever rendering code contents via `dangerouslySetInnerHTML`, consider using an `escapeHtml` utility rather than `DOMPurify` to ensure code integrity while still defending against XSS.
